#!/usr/bin/env node
// End-to-end and adversarial tests against a real public GitHub repo. Every result
// comes from GitHub's own API state rather than from what an agent reports.
//
//   node tests/e2e/sandbox.mjs <sandbox-clone-dir> [scenario-prefix ...]
//
// The sandbox must be a repo created with `pipeline init` and protected with
// `pipeline protect`. This opens and closes real PRs there.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const only = process.argv.slice(3);
const { changeSet } = await import(`file:///${join(dir, '.pipeline/lib/git.mjs').replaceAll('\\', '/')}`);

const sh = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const git = (...args) => sh('git', args);
const gh = (...args) => sh('gh', args);
const api = (path) => JSON.parse(gh('api', path));
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const CONTRACT = '## Testing\nRan the test suite.\n\n## Risk\nSandbox test.\n\n## How to revert\nRevert the squash commit.\n';
const verdict = (hash, tier, open = { blocker: 0, should: 0 }) =>
  `\n<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier, rounds: 1, open })}\n-->\n`;

let serial = Date.now() % 100000;
const openPrs = [];

function freshBranch(name) {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  const branch = `e2e/${name}-${(serial += 1)}`;
  git('checkout', '-q', '-b', branch);
  return branch;
}

function write(path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commitAndPush(message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  git('push', '-q', '-u', 'origin', 'HEAD');
  return git('rev-parse', 'HEAD');
}

const hashNow = () => changeSet('origin/main', 'HEAD', dir).hash;

function openPr(title, body) {
  const bodyFile = join(dir, '.git', 'pr-body.md');
  writeFileSync(bodyFile, body);
  const url = gh('pr', 'create', '--title', title, '--body-file', bodyFile);
  const number = Number(url.split('/').pop());
  openPrs.push(number);
  return number;
}

function setBody(number, body) {
  const bodyFile = join(dir, '.git', 'pr-body.md');
  writeFileSync(bodyFile, body);
  gh('pr', 'edit', String(number), '--body-file', bodyFile);
}

const headOf = (number) => api(`repos/${repo}/pulls/${number}`).head.sha;

function gateCheck(sha) {
  const runs = api(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent('pipeline/gate')}&filter=latest`).check_runs;
  return runs.sort((a, b) => b.id - a.id)[0] ?? null;
}

// Waits until the gate has reached a settled state for this head.
async function settled(number, { want, timeout = 240000 } = {}) {
  const deadline = Date.now() + timeout;
  let check = null;
  while (Date.now() < deadline) {
    const sha = headOf(number);
    check = gateCheck(sha);
    if (check?.status === 'completed' && (!want || want.includes(check.conclusion))) return check;
    await sleep(6000);
  }
  return check;
}

function tryMerge(number, ...flags) {
  const result = spawnSync('gh', ['pr', 'merge', String(number), '--squash', ...flags], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

const stateOf = (number) => {
  const pr = api(`repos/${repo}/pulls/${number}`);
  return { merged: pr.merged, state: pr.state };
};

async function waitMerged(number, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stateOf(number).merged) return true;
    await sleep(5000);
  }
  return false;
}

function comment(number, body) {
  return JSON.parse(
    sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'], {
      input: JSON.stringify({ body }),
    }),
  );
}

function closePr(number) {
  spawnSync('gh', ['pr', 'close', String(number), '--delete-branch'], { cwd: dir });
}

const results = [];
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function scenario(id, title, run) {
  if (only.length > 0 && !only.some((prefix) => id.startsWith(prefix))) return;
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ id, title, pass: true, seconds: Math.round((Date.now() - started) / 1000), detail });
    console.log(`PASS ${id} ${title}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    results.push({ id, title, pass: false, seconds: Math.round((Date.now() - started) / 1000), detail: error.message });
    console.log(`FAIL ${id} ${title}\n     ${error.message}`);
  }
  for (const number of openPrs.splice(0)) closePr(number);
}

// ---- Adversarial: every one of these must fail to merge ----

await scenario('A1', 'A PR that rewrites gate.yml and ci.yml to always pass can\'t merge', async () => {
  freshBranch('rewrite-gate');
  const allPass = (name) =>
    `name: ${name}\non:\n  pull_request:\n  pull_request_target:\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`;
  write('.github/workflows/gate.yml', allPass('gate'));
  write('.github/workflows/ci.yml', allPass('ci'));
  commitAndPush('Make every check pass');
  const number = openPr('Make every check pass', `${CONTRACT}${verdict(hashNow(), 2)}`);
  const check = await settled(number, { want: ['action_required', 'failure'] });
  expect(check?.conclusion === 'action_required', `gate concluded ${check?.conclusion}: ${check?.output?.title}`);
  expect(check.app.slug === 'github-actions', `check came from ${check.app.slug}`);
  const merge = tryMerge(number);
  expect(!merge.ok, `merge succeeded: ${merge.output}`);
  expect(!stateOf(number).merged, 'PR merged');
  return `gate: ${check.output.title}`;
});

await scenario('A2', 'A PR that sets T2 to auto in the policy file can\'t merge', async () => {
  freshBranch('weaken-policy');
  const config = JSON.parse(readFileSync(join(dir, 'pipeline.config.json'), 'utf8'));
  config.merge.t2 = 'auto';
  config.tiers.t2Paths = [];
  write('pipeline.config.json', `${JSON.stringify(config, null, 2)}\n`);
  commitAndPush('Tune the merge policy');
  const number = openPr('Tune the merge policy', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const check = await settled(number, { want: ['action_required', 'failure'] });
  expect(['action_required', 'failure'].includes(check?.conclusion), `gate concluded ${check?.conclusion}`);
  expect(/T2/.test(check.output.title), `not treated as T2: ${check.output.title}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return `gate: ${check.output.title}`;
});

await scenario('A3a', 'A workflow moved into docs/ is still T2', async () => {
  freshBranch('move-workflow');
  renameSync(join(dir, '.github/workflows/gate.yml'), join(dir, 'docs/gate-notes.md'));
  commitAndPush('Move notes');
  const number = openPr('Move notes', `${CONTRACT}${verdict(hashNow(), 0)}`);
  const check = await settled(number, { want: ['action_required', 'failure'] });
  expect(/T2/.test(check?.output?.title ?? ''), `gate: ${check?.output?.title}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return `gate: ${check.output.title}`;
});

await scenario('A3b', 'A .Claude case variant is still T2', async () => {
  freshBranch('case-variant');
  write('.Claude/Settings.json', '{"permissions":{"defaultMode":"bypassPermissions"}}\n');
  commitAndPush('Add settings');
  const number = openPr('Add settings', `${CONTRACT}${verdict(hashNow(), 2)}`);
  const check = await settled(number, { want: ['action_required', 'failure'] });
  expect(check?.conclusion === 'action_required', `gate concluded ${check?.conclusion}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return `gate: ${check.output.title}`;
});

await scenario('A4a', 'A whitespace-only change after a verdict voids it', async () => {
  freshBranch('whitespace');
  write('src/math.js', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  commitAndPush('Add sub');
  const number = openPr('Add sub', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const green = await settled(number, { want: ['success'] });
  expect(green?.conclusion === 'success', `baseline gate: ${green?.conclusion} ${green?.output?.title} ${green?.output?.summary}`);
  write('src/math.js', 'export const add = (a, b) => a + b;\nexport const sub = (a,  b) => a - b;\n');
  commitAndPush('Whitespace');
  const check = await settled(number, { want: ['failure'] });
  expect(check?.conclusion === 'failure', `gate concluded ${check?.conclusion}`);
  expect(/different content/.test(check.output.summary), check.output.summary);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'verdict voided';
});

await scenario('A4b', 'A swapped binary after a verdict voids it', async () => {
  freshBranch('binary');
  write('assets/app.wasm', Buffer.from([0, 97, 115, 109, 1]));
  commitAndPush('Add wasm');
  const number = openPr('Add wasm', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const green = await settled(number, { want: ['success'] });
  expect(green?.conclusion === 'success', `baseline gate: ${green?.conclusion}`);
  write('assets/app.wasm', Buffer.from([0, 97, 115, 109, 2]));
  commitAndPush('Update wasm');
  const check = await settled(number, { want: ['failure'] });
  expect(/different content/.test(check?.output?.summary ?? ''), `gate: ${check?.output?.summary}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'verdict voided';
});

await scenario('A5a', 'A failing verify blocks the merge', async () => {
  freshBranch('red-tests');
  write('tests/fails.test.mjs', "import { test } from 'node:test';\ntest('fails', () => { throw new Error('red'); });\n");
  commitAndPush('Add a failing test');
  const number = openPr('Add a failing test', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const check = await settled(number, { want: ['failure'] });
  expect(/verify concluded failure/.test(check?.output?.summary ?? ''), `gate: ${check?.output?.summary}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'blocked by red verify';
});

await scenario('A5b', 'A skipped verify blocks even with a valid approval', async () => {
  freshBranch('skip-verify');
  const ci = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
  write('.github/workflows/ci.yml', ci.replace(/if: \$\{\{[^\n]*\}\}/, 'if: false'));
  commitAndPush('Skip verify');
  const hash = hashNow();
  const number = openPr('Skip verify', `${CONTRACT}${verdict(hash, 2)}`);
  await sleep(15000);
  comment(number, `/approve ${hash.slice(0, 12)}`);
  const check = await settled(number, { want: ['failure'] });
  expect(/verify concluded skipped/.test(check?.output?.summary ?? ''), `gate: ${check?.conclusion} ${check?.output?.summary}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'skipped is not success';
});

await scenario('A6', 'A forged status or check can\'t satisfy the gate', async () => {
  freshBranch('forge');
  write('src/forged.js', 'export const x = 1;\n');
  const sha = commitAndPush('No verdict at all');
  const number = openPr('No verdict at all', 'No contract and no verdict.');
  await settled(number, { want: ['failure'] });

  const check = spawnSync(
    'gh',
    ['api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'],
    {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ name: 'pipeline/gate', head_sha: sha, status: 'completed', conclusion: 'success', output: { title: 'x', summary: 'x' } }),
    },
  );
  expect(check.status !== 0, 'the owner token could create a check run');

  const status = spawnSync(
    'gh',
    ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', 'state=success', '-f', 'context=pipeline/gate'],
    { cwd: dir, encoding: 'utf8' },
  );
  const statusPosted = status.status === 0;
  await sleep(4000);
  const merge = tryMerge(number);
  expect(!merge.ok, `merge succeeded after forging: ${merge.output}`);
  expect(!stateOf(number).merged, 'PR merged');
  return `check run refused; status ${statusPosted ? 'posted but ignored' : 'refused'}`;
});

await scenario('A7a', 'A comment that merely quotes the approval does nothing', async () => {
  freshBranch('quote-approve');
  write('.pipeline/note.md', 'note\n');
  commitAndPush('Protected note');
  const hash = hashNow();
  const short = hash.slice(0, 12);
  const number = openPr('Protected note', `${CONTRACT}${verdict(hash, 2)}`);
  await settled(number, { want: ['action_required'] });
  comment(number, `The owner should post /approve ${short} when ready.`);
  comment(number, `> /approve ${short}`);
  comment(number, `\`/approve ${short}\``);
  await sleep(20000);
  const check = await settled(number, { want: ['action_required', 'success'] });
  expect(check?.conclusion === 'action_required', `gate concluded ${check?.conclusion}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'still waiting';
});

await scenario('A7b', 'An edited approval comment stops counting', async () => {
  freshBranch('edit-approve');
  write('.pipeline/note2.md', 'note\n');
  commitAndPush('Protected note 2');
  const hash = hashNow();
  const short = hash.slice(0, 12);
  const number = openPr('Protected note 2', `${CONTRACT}${verdict(hash, 2)}`);
  await settled(number, { want: ['action_required'] });
  const posted = comment(number, `Reviewing ${short}.`);
  sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${posted.id}`, '--input', '-'], {
    input: JSON.stringify({ body: `/approve ${short}` }),
  });
  await sleep(25000);
  const check = await settled(number, { want: ['action_required', 'success'] });
  expect(check?.conclusion === 'action_required', `gate concluded ${check?.conclusion}: an edited comment approved`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return 'still waiting';
});

await scenario('A8', 'Direct pushes to main are refused, even for the owner', async () => {
  freshBranch('direct');
  write('src/direct.js', 'export const y = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Direct push');
  const refused = spawnSync('git', ['push', 'origin', 'HEAD:main'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_ADMIN_PUSH: '1' },
  });
  git('checkout', '-q', 'main');
  expect(refused.status !== 0, 'the direct push succeeded');
  expect(/protected branch|GH006|required/i.test(refused.stderr), refused.stderr);
  return 'server refused it';
});

await scenario('A9', 'The admin override can\'t bypass a red gate', async () => {
  freshBranch('admin-merge');
  write('src/admin.js', 'export const z = 1;\n');
  commitAndPush('Admin merge attempt');
  const number = openPr('Admin merge attempt', 'No contract.');
  await settled(number, { want: ['failure'] });
  const merge = tryMerge(number, '--admin');
  expect(!merge.ok, `--admin merged: ${merge.output}`);
  expect(!stateOf(number).merged, 'PR merged');
  return 'refused';
});

// ---- End to end: these must succeed ----

let mergedSha = null;

await scenario('E1', 'A docs PR auto-merges with no human', async () => {
  freshBranch('docs');
  write('docs/guide.md', `# Guide\n\nRun ${serial}.\n`);
  commitAndPush('Add guide');
  const number = openPr('Add guide', `${CONTRACT}${verdict(hashNow(), 0)}`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `not merged. Gate: ${check?.conclusion} ${check?.output?.title} ${check?.output?.summary}`);
  expect(/T0/.test(check.output.title), check.output.title);
  return check.output.title;
});

await scenario('E2', 'An ordinary change with a clean verdict auto-merges', async () => {
  freshBranch('feature');
  write('src/feature.js', `export const feature = ${serial};\n`);
  commitAndPush('Add a feature');
  const number = openPr('Add a feature', `${CONTRACT}${verdict(hashNow(), 1)}`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `not merged. Gate: ${check?.conclusion} ${check?.output?.title} ${check?.output?.summary}`);
  mergedSha = api(`repos/${repo}/pulls/${number}`).merge_commit_sha;
  return check.output.title;
});

await scenario('E3', 'A T2 change waits, an approval opens it, and a new commit voids the approval', async () => {
  freshBranch('t2-approve');
  write('.pipeline/note3.md', `note ${serial}\n`);
  commitAndPush('Protected note 3');
  let hash = hashNow();
  const number = openPr('Protected note 3', `${CONTRACT}${verdict(hash, 2)}`);
  const waiting = await settled(number, { want: ['action_required'] });
  expect(waiting?.conclusion === 'action_required', `gate: ${waiting?.conclusion}`);
  expect(waiting.output.summary.includes(`/approve ${hash.slice(0, 12)}`), waiting.output.summary);

  comment(number, `/approve ${hash.slice(0, 12)}`);
  const approved = await settled(number, { want: ['success'] });
  expect(approved?.conclusion === 'success', `after approval: ${approved?.conclusion} ${approved?.output?.summary}`);

  // Every approval produces a bot notification.
  await sleep(3000);
  const comments = api(`repos/${repo}/issues/${number}/comments`);
  expect(
    comments.some((c) => c.user.login === 'github-actions[bot]' && /approval recorded/.test(c.body)),
    'no bot echo for the approval',
  );

  write('.pipeline/note3.md', `note ${serial} changed\n`);
  commitAndPush('Change after approval');
  hash = hashNow();
  setBody(number, `${CONTRACT}${verdict(hash, 2)}`);
  const voided = await settled(number, { want: ['action_required'] });
  expect(voided?.conclusion === 'action_required', `after new commit: ${voided?.conclusion}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'merged on a stale approval');

  comment(number, `/approve ${hash.slice(0, 12)}`);
  const reapproved = await settled(number, { want: ['success'] });
  expect(reapproved?.conclusion === 'success', `after re-approval: ${reapproved?.conclusion}`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  expect(await waitMerged(number), 'not merged after re-approval');
  return 'approve, void, re-approve, merge';
});

await scenario('E4', 'A clean rebase keeps a verdict valid', async () => {
  freshBranch('rebase-base');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  write('src/rebased.js', `export const rebased = ${serial};\n`);
  commitAndPush('Rebased change');
  const hash = hashNow();
  const number = openPr('Rebased change', `${CONTRACT}${verdict(hash, 1)}`);
  await settled(number, { want: ['success'] });

  // Land something unrelated on main so the PR falls behind.
  freshBranch('rebase-other');
  write('docs/other.md', `# Other ${serial}\n`);
  commitAndPush('Unrelated docs');
  const other = openPr('Unrelated docs', `${CONTRACT}${verdict(hashNow(), 0)}`);
  gh('pr', 'merge', String(other), '--auto', '--squash');
  expect(await waitMerged(other, 240000), 'unrelated PR did not merge');

  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  git('checkout', '-q', branch);
  git('rebase', '-q', 'main');
  git('push', '-q', '--force-with-lease');
  expect(hashNow() === hash, 'the rebase changed the hash');
  const check = await settled(number, { want: ['success'] });
  expect(check?.conclusion === 'success', `after rebase: ${check?.conclusion} ${check?.output?.summary}`);
  return 'verdict survived';
});

await scenario('E5', 'A bad merge reverts through the fast path', async () => {
  expect(mergedSha, 'needs E2 to have run');
  const started = Date.now();
  freshBranch('revert');
  git('revert', '--no-edit', mergedSha);
  git('push', '-q', '-u', 'origin', 'HEAD');
  const number = openPr('Revert "Add a feature"', `Undoing the bad change.\n\nRevert-of: ${mergedSha}\n`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `not merged. Gate: ${check?.conclusion} ${check?.output?.title} ${check?.output?.summary}`);
  return `back on main in ${Math.round((Date.now() - started) / 1000)}s; ${check.output.title}`;
});

await scenario('E6', 'A dishonest revert with extra content gets no fast path', async () => {
  freshBranch('fake-revert');
  write('src/sneaky.js', 'export const sneaky = true;\n');
  commitAndPush('Revert something');
  const log = git('log', 'origin/main', '--format=%H', '-n', '1');
  const number = openPr('Revert "something"', `Revert-of: ${log}\n`);
  const check = await settled(number, { want: ['failure'] });
  expect(check?.conclusion === 'failure', `gate: ${check?.conclusion} ${check?.output?.title}`);
  expect(!tryMerge(number).ok && !stateOf(number).merged, 'PR merged');
  return check.output.title;
});

git('checkout', '-q', 'main');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(dir, '.git', 'e2e-results.json'), JSON.stringify(results, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
