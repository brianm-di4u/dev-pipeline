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

// ---- Detection, decisions, and private mode ----

const owner = repo.split('/')[0];
const issues = (label, state = 'open') =>
  api(`repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&per_page=50`).filter((i) => !i.pull_request);

async function waitFor(what, predicate, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(6000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Lands a T1 change, and returns its merge commit.
async function landOrdinary(name, path, content) {
  freshBranch(name);
  write(path, content);
  commitAndPush(`Add ${name}`);
  const number = openPr(`Add ${name}`, `${CONTRACT}${verdict(hashNow(), 1)}`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `${name} did not merge. Gate: ${check?.conclusion} ${check?.output?.title} ${check?.output?.summary}`);
  return api(`repos/${repo}/pulls/${number}`).merge_commit_sha;
}

async function revertIt(sha, name) {
  freshBranch(`undo-${name}`);
  git('revert', '--no-edit', sha);
  git('push', '-q', '-u', 'origin', 'HEAD');
  const number = openPr(`Revert "${name}"`, `Undoing it.\n\nRevert-of: ${sha}\n`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `revert did not merge. Gate: ${check?.conclusion} ${check?.output?.summary}`);
}

await scenario('S0', 'A template update lands as a T2 PR with an approval', async () => {
  const cli = new URL('../../bin/pipeline.mjs', import.meta.url);
  freshBranch('update');
  const output = execFileSync('node', [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('%20', ' '), 'update', '--dir', dir], {
    cwd: dir,
    encoding: 'utf8',
  });
  expect(/updated/.test(output), output);
  const conflicts = output.split('\n').filter((line) => line.includes('KEPT'));
  commitAndPush('Update from the template');
  const hash = hashNow();
  const number = openPr('Update from the template', `${CONTRACT}${verdict(hash, 2)}`);
  await settled(number, { want: ['action_required', 'failure'] });
  comment(number, `/approve ${hash.slice(0, 12)}`);
  gh('pr', 'merge', String(number), '--auto', '--squash');
  const merged = await waitMerged(number, 240000);
  const check = gateCheck(headOf(number));
  expect(merged, `not merged. Gate: ${check?.conclusion} ${check?.output?.title} ${check?.output?.summary}`);
  return `merged; ${conflicts.length} locally modified files kept`;
});

await scenario('D1', 'A decision request notifies the owner; /decide labels it; the ADR is T0 only when it cites it', async () => {
  const issue = JSON.parse(
    sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'], {
      input: JSON.stringify({ title: 'Decision: which license?', body: 'Options:\n- **A (recommended):** MIT\n- **B:** Apache-2.0', labels: ['decision-needed'] }),
    }),
  );
  await waitFor('the bot @mention', () =>
    api(`repos/${repo}/issues/${issue.number}/comments`).find(
      (c) => c.user.login === 'github-actions[bot]' && c.body.includes(`@${owner}`),
    ),
  );

  comment(issue.number, 'Maybe /decide A, thinking about it.');
  await sleep(15000);
  expect(!api(`repos/${repo}/issues/${issue.number}`).labels.some((l) => l.name === 'decided'), 'a quoted /decide counted');

  comment(issue.number, '/decide A');
  await waitFor('the decided label', () => api(`repos/${repo}/issues/${issue.number}`).labels.some((l) => l.name === 'decided'));

  // Without the citation, it's T2.
  freshBranch('adr-uncited');
  write('docs/decisions/0002-license.md', `# 0002: License\n\nMIT. ${serial}\n`);
  commitAndPush('Record a decision with no citation');
  const uncited = openPr('Record a decision with no citation', `${CONTRACT}${verdict(hashNow(), 2)}`);
  const check = await settled(uncited, { want: ['action_required'] });
  expect(/T2/.test(check?.output?.title ?? ''), `uncited ADR: ${check?.output?.title}`);
  closePr(uncited);

  // With the citation, it merges as T0.
  freshBranch('adr-cited');
  write('docs/decisions/0002-license.md', `# 0002: License\n\nMIT. ${serial}\n`);
  commitAndPush('Record the license decision');
  const cited = openPr('Record the license decision', `${CONTRACT}Decision: #${issue.number}\n${verdict(hashNow(), 0)}`);
  gh('pr', 'merge', String(cited), '--auto', '--squash');
  const merged = await waitMerged(cited, 240000);
  const final = gateCheck(headOf(cited));
  expect(merged, `cited ADR: ${final?.conclusion} ${final?.output?.title} ${final?.output?.summary}`);
  expect(/T0/.test(final.output.title), final.output.title);
  sh('gh', ['issue', 'close', String(issue.number)]);
  return 'notified, decided, recorded';
});

await scenario('D2', 'A GPL dependency is blocked, and other work carries on', async () => {
  freshBranch('gpl');
  write(
    'package-lock.json',
    `${JSON.stringify({ name: 'pipeline-sandbox', lockfileVersion: 3, packages: { '': { name: 'pipeline-sandbox' }, 'node_modules/copyleft-thing': { version: '1.0.0', license: 'GPL-3.0-only' } } }, null, 2)}\n`,
  );
  commitAndPush('Add a dependency');
  const blocked = openPr('Add a dependency', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const check = await settled(blocked, { want: ['failure'] });
  expect(/verify concluded failure/.test(check?.output?.summary ?? ''), `gate: ${check?.conclusion} ${check?.output?.summary}`);
  const runId = api(`repos/${repo}/actions/runs?event=pull_request&per_page=5`).workflow_runs.find((r) => r.head_sha === headOf(blocked))?.id;
  const log = spawnSync('gh', ['run', 'view', String(runId), '--log-failed'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 }).stdout;
  expect(/needs a legal decision/.test(log), `the failure doesn't say why: ${log.slice(-300)}`);
  expect(/copyleft-thing/.test(log), 'the failure does not name the package');

  // Parking this PR doesn't stop other work.
  freshBranch('docs-while-parked');
  write('docs/other-work.md', `# Other work ${serial}\n`);
  commitAndPush('Other work');
  const other = openPr('Other work', `${CONTRACT}${verdict(hashNow(), 0)}`);
  gh('pr', 'merge', String(other), '--auto', '--squash');
  expect(await waitMerged(other, 240000), 'other work did not merge');
  return 'blocked with the reason; other work merged';
});

await scenario('M1', 'A red main notifies the owner, blocks T1, and a clean revert restores it', async () => {
  const sha = await landOrdinary(
    'red-on-main',
    'tests/red-on-main.test.mjs',
    "import { test } from 'node:test';\ntest('fails only on main', () => { if (process.env.GITHUB_EVENT_NAME === 'push') throw new Error('red'); });\n",
  );
  const red = await waitFor('the main-red issue', () =>
    issues('pipeline:main-red').find((i) => i.user.login === 'github-actions[bot]'),
  );
  expect(red.body.includes(`@${owner}`), 'the issue does not mention the owner');

  freshBranch('blocked-by-red');
  write('src/blocked.js', `export const blocked = ${serial};\n`);
  commitAndPush('Blocked by red main');
  const blocked = openPr('Blocked by red main', `${CONTRACT}${verdict(hashNow(), 1)}`);
  const check = await settled(blocked, { want: ['failure'] });
  expect(/Main is red/.test(check?.output?.summary ?? ''), `gate: ${check?.conclusion} ${check?.output?.summary}`);
  expect(!tryMerge(blocked).ok, 'merged on a red main');
  closePr(blocked);

  await revertIt(sha, 'red-on-main');
  await waitFor('the main-red issue to close', () => issues('pipeline:main-red').length === 0);
  return 'notified, blocked, reverted, cleared';
});

await scenario('B1', 'Repeated failures trip the breaker, closing the issue is not enough, and /rearm clears it', async () => {
  let cycles = 0;
  while (issues('pipeline:breaker').length === 0 && cycles < 3) {
    cycles += 1;
    const sha = await landOrdinary(`cycle-${cycles}`, `src/cycle${serial}.js`, `export const c = ${serial};\n`);
    await revertIt(sha, `cycle-${cycles}`);
    await sleep(45000);
  }
  const breaker = await waitFor('the breaker issue', () =>
    issues('pipeline:breaker').find((i) => i.user.login === 'github-actions[bot]'),
  );
  expect(breaker.body.includes(`@${owner}`), 'the issue does not mention the owner');

  freshBranch('during-breaker');
  write('src/during.js', `export const during = ${serial};\n`);
  commitAndPush('During the breaker');
  const hash = hashNow();
  const held = openPr('During the breaker', `${CONTRACT}${verdict(hash, 1)}`);
  let check = await settled(held, { want: ['action_required'] });
  expect(check?.conclusion === 'action_required', `T1 while tripped: ${check?.conclusion} ${check?.output?.summary}`);
  expect(/circuit breaker/i.test(check.output.summary), check.output.summary);

  // An agent closing the issue doesn't re-arm anything.
  sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/${breaker.number}`, '--input', '-'], { input: '{"state":"closed"}' });
  setBody(held, `${CONTRACT}${verdict(hash, 1)}\n\nNudge.`);
  await sleep(20000);
  check = await settled(held, { want: ['action_required', 'success'] });
  expect(check?.conclusion === 'action_required', `closing the issue re-armed it: ${check?.conclusion}`);

  comment(breaker.number, '/rearm');
  await sleep(20000);
  setBody(held, `${CONTRACT}${verdict(hash, 1)}\n\nNudge again.`);
  check = await settled(held, { want: ['success'] });
  expect(check?.conclusion === 'success', `after /rearm: ${check?.conclusion} ${check?.output?.summary}`);
  return `tripped after ${cycles} extra cycles; closing did nothing; /rearm cleared it`;
});

await scenario('U1', 'The audit notices weakened protection, and the digest is posted', async () => {
  const dispatch = async () => {
    const before = api(`repos/${repo}/actions/workflows/audit.yml/runs?per_page=1`).workflow_runs[0]?.id;
    gh('workflow', 'run', 'audit.yml');
    await waitFor('the audit run to finish', () => {
      const run = api(`repos/${repo}/actions/workflows/audit.yml/runs?per_page=1`).workflow_runs[0];
      return run && run.id !== before && run.status === 'completed' ? run : null;
    });
  };
  await dispatch();
  expect(issues('pipeline:audit').length === 0, 'the audit flagged healthy protection');
  const digest = issues('pipeline:digest').find((i) => i.user.login === 'github-actions[bot]');
  expect(digest, 'no digest was posted');
  expect(digest.body.includes(`@${owner}`) && /Merged/.test(digest.body), digest.body.slice(0, 200));

  sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/branches/main/protection/required_status_checks`, '--input', '-'], {
    input: JSON.stringify({ strict: true, checks: [{ context: 'pipeline/gate', app_id: -1 }] }),
  });
  await dispatch();
  const flagged = issues('pipeline:audit').find((i) => i.user.login === 'github-actions[bot]');
  sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/branches/main/protection/required_status_checks`, '--input', '-'], {
    input: JSON.stringify({ strict: true, checks: [{ context: 'pipeline/gate', app_id: 15368 }] }),
  });
  expect(flagged, 'the audit missed an unpinned check');
  await dispatch();
  expect(issues('pipeline:audit').length === 0, 'the audit issue did not close after the repair');
  return 'healthy, flagged, repaired; digest posted';
});

// GitHub refuses a visibility change while the last one is still settling.
async function setVisibility(visibility) {
  const deadline = Date.now() + 300000;
  for (;;) {
    const result = spawnSync('gh', ['repo', 'edit', repo, '--visibility', visibility, '--accept-visibility-change-consequences'], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (result.status === 0) return;
    if (Date.now() > deadline) throw new Error(`Could not set ${visibility}: ${result.stderr}`);
    await sleep(15000);
  }
}

await scenario('P1', 'Private mode: CI stays off, the local gate still blocks, and doctor says advisory', async () => {
  const cli = new URL('../../bin/pipeline.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('%20', ' ');
  await setVisibility('private');
  try {
    const doctor = spawnSync('node', [cli, 'doctor', '--repo', repo, '--dir', dir], { cwd: dir, encoding: 'utf8' });
    expect(/advisory/i.test(doctor.stdout), doctor.stdout);

    freshBranch('private');
    write('src/private.js', `export const p = ${serial};\n`);
    const sha = commitAndPush('Private change');
    const number = openPr('Private change', 'No contract.');
    await sleep(25000);
    const runs = api(`repos/${repo}/actions/runs?head_sha=${sha}`).workflow_runs;
    const executed = runs.filter((r) => r.conclusion && !['skipped', 'cancelled'].includes(r.conclusion));
    expect(executed.length === 0, `CI ran on a private repo: ${executed.map((r) => `${r.name}:${r.conclusion}`).join(', ')}`);

    const gate = (...extra) =>
      spawnSync('node', ['.pipeline/gate.mjs', 'local', '--pr', String(number), '--evidence', ...extra], { cwd: dir, encoding: 'utf8' });
    let result = gate();
    expect(result.status === 1, `the local gate passed with no contract: ${result.stdout}`);
    expect(/PR contract is missing/.test(result.stdout), result.stdout);

    const verified = spawnSync('node', ['.pipeline/verify.mjs', 'full'], { cwd: dir, encoding: 'utf8' });
    expect(verified.status === 0, verified.stdout);
    setBody(number, `${CONTRACT}${verdict(hashNow(), 1)}`);
    result = gate();
    expect(result.status === 0, `the local gate refused a good PR: ${result.stdout}`);
    expect(/T1: ready to merge/.test(result.stdout), result.stdout);

    const hook = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PIPELINE_ADMIN_PUSH: '' } });
    expect(hook.status !== 0 && /Blocked/.test(hook.stderr), `the pre-push hook did not block: ${hook.stderr}`);
    return 'advisory reported; CI off; local gate correct; hook blocks';
  } finally {
    await setVisibility('public');
    execFileSync('node', [cli, 'protect', '--repo', repo], { cwd: dir, encoding: 'utf8' });
  }
});

git('checkout', '-q', 'main');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(dir, '.git', 'e2e-results.json'), JSON.stringify(results, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
