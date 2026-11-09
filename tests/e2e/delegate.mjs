#!/usr/bin/env node
// End-to-end checks of a delegate approver against a real public sandbox repo.
// Every result comes from GitHub's own state.
//
//   node tests/e2e/delegate.mjs <sandbox-clone-dir> [scenario-prefix ...]
//
// Run it from your own terminal, where `gh` is you (the admin), against a clone
// of the sandbox (brianm-di4u/pipeline-sandbox). The delegate's token comes from
// PIPELINE_DELEGATE_TOKEN, which this never prints. Set it without echoing, for
// example in PowerShell:
//
//   $env:PIPELINE_DELEGATE_TOKEN = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Delegate token')).Password
//
// The token must belong to the expected delegate: gwb-gardener, or the login in
// PIPELINE_DELEGATE_LOGIN. Without a token it skips, and exits 0. The sandbox must run this
// version of the pipeline, workflows included, with the delegate account invited
// as a collaborator and listed under `delegates` in pipeline.config.json on main,
// with approve, rearm, and decide for design. This opens, merges, reverts and
// closes real PRs and issues there. Scenario D8 removes `delegates` from main for
// a while, and puts it back.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const TOKEN = process.env.PIPELINE_DELEGATE_TOKEN ?? '';
const EXPECTED = process.env.PIPELINE_DELEGATE_LOGIN || 'gwb-gardener';
if (!TOKEN) {
  console.log('SKIP delegate e2e: PIPELINE_DELEGATE_TOKEN is not set. See the header of tests/e2e/delegate.mjs.');
  process.exit(0);
}

const dir = resolve(process.argv[2] ?? '.');
const only = process.argv.slice(3);
const { changeSet } = await import(`file:///${join(dir, '.pipeline/lib/git.mjs').replaceAll('\\', '/')}`);

const adminEnv = { ...process.env, PIPELINE_DELEGATE_TOKEN: '' };
const delegateEnv = { ...process.env, GH_TOKEN: TOKEN, GITHUB_TOKEN: '', PIPELINE_DELEGATE_TOKEN: '' };
// Errors from a delegate call can quote the request, never the token, but scrub anyway.
const scrub = (text) => (text ?? '').split(TOKEN).join('<token>');

const sh = (command, args, { env = adminEnv, input } = {}) => {
  try {
    return execFileSync(command, args, { cwd: dir, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(scrub(`${command} ${args.join(' ')}: ${error.stderr || error.message}`));
  }
};
const run = (command, args, { env = adminEnv, input } = {}) => {
  const result = spawnSync(command, args, { cwd: dir, env, input, encoding: 'utf8' });
  return { ok: result.status === 0, out: scrub(`${result.stdout}${result.stderr}`.trim()) };
};
const git = (...args) => sh('git', args);
const gh = (...args) => sh('gh', args);
const asDelegate = (...args) => sh('gh', args, { env: delegateEnv });
const api = (path, env = adminEnv) => JSON.parse(sh('gh', ['api', path], { env }));
const post = (path, body, env = adminEnv) => JSON.parse(sh('gh', ['api', '-X', 'POST', path, '--input', '-'], { env, input: JSON.stringify(body) }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
const admin = gh('api', 'user', '--jq', '.login');
const delegate = JSON.parse(asDelegate('api', 'user'));
const mainConfig = () => JSON.parse(Buffer.from(api(`repos/${repo}/contents/pipeline.config.json?ref=main`).content, 'base64').toString('utf8'));
const grantOf = (config) => (config.delegates ?? []).find((d) => d.login?.toLowerCase() === delegate.login.toLowerCase());
if (delegate.login.toLowerCase() === admin.toLowerCase()) {
  console.log('FAIL the delegate token belongs to the admin. Use a token made on the delegate account.');
  process.exit(1);
}
if (delegate.login.toLowerCase() !== EXPECTED.toLowerCase()) {
  console.log(`FAIL the delegate token belongs to ${delegate.login}, not ${EXPECTED}. Set PIPELINE_DELEGATE_LOGIN if that's intended.`);
  process.exit(1);
}
if (!grantOf(mainConfig())) {
  console.log(`FAIL ${delegate.login} isn't under "delegates" in ${repo}'s pipeline.config.json on main.`);
  process.exit(1);
}

const CONTRACT = '## Testing\nRan the test suite.\n\n## Risk\nSandbox test.\n\n## How to revert\nRevert the squash commit.\n';
const verdict = (hash, tier) => `\n<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->\n`;
let serial = Date.now() % 100000;
const openPrs = [];
const openIssues = [];

function freshBranch(name) {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  const branch = `e2e/delegate-${name}-${(serial += 1)}`;
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
// The delegate's own commit and push, under its own identity and token.
function delegateCommitAndPush(message, branch) {
  const id = ['-c', `user.name=${delegate.login}`, '-c', `user.email=${delegate.id}+${delegate.login}@users.noreply.github.com`];
  const creds = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
  sh('git', ['add', '-A']);
  sh('git', [...id, 'commit', '-q', '-m', message]);
  sh('git', [...creds, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { env: delegateEnv });
}
const hashNow = () => changeSet('origin/main', 'HEAD', dir).hash;
function openPr(title, body, env = adminEnv) {
  const bodyFile = join(dir, '.git', 'pr-body.md');
  writeFileSync(bodyFile, body);
  const url = sh('gh', ['pr', 'create', '--title', title, '--body-file', bodyFile], { env });
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
const gateCheck = (sha) =>
  api(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent('pipeline/gate')}&filter=latest`).check_runs.sort((a, b) => b.id - a.id)[0] ?? null;
async function settled(number, { want, timeout = 300000 } = {}) {
  const deadline = Date.now() + timeout;
  let check = null;
  while (Date.now() < deadline) {
    check = gateCheck(headOf(number));
    if (check?.status === 'completed' && (!want || want.includes(check.conclusion))) return check;
    await sleep(6000);
  }
  return check;
}
const comments = (number) => api(`repos/${repo}/issues/${number}/comments?per_page=100`);
async function botSays(number, pattern, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = comments(number).find((c) => c.user.login === 'github-actions[bot]' && pattern.test(c.body));
    if (found) return found;
    await sleep(6000);
  }
  return null;
}
const say = (number, body, env = adminEnv) => post(`repos/${repo}/issues/${number}/comments`, { body }, env);
const stateOf = (number) => api(`repos/${repo}/pulls/${number}`);
async function waitMerged(number, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stateOf(number).merged) return true;
    await sleep(6000);
  }
  return false;
}
function cleanup() {
  for (const number of openPrs.splice(0)) run('gh', ['pr', 'close', String(number), '--delete-branch']);
  for (const number of openIssues.splice(0)) run('gh', ['issue', 'close', String(number)]);
  run('git', ['checkout', '-q', 'main']);
}

const results = [];
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
async function scenario(id, title, body) {
  if (only.length > 0 && !only.some((prefix) => id.startsWith(prefix))) return;
  const started = Date.now();
  try {
    const detail = await body();
    results.push({ id, pass: true });
    console.log(`PASS ${id} ${title}${detail ? ` (${detail})` : ''} [${Math.round((Date.now() - started) / 1000)}s]`);
  } catch (error) {
    results.push({ id, pass: false });
    console.log(`FAIL ${id} ${title}\n     ${scrub(error.message)}`);
  }
  cleanup();
}

// A worker's T2 PR: `src/auth/**` is a protected path in the template config.
async function t2Pr(name, path = `src/auth/${name}.js`) {
  const branch = freshBranch(name);
  write(path, `export const e2e = ${serial};\n`);
  commitAndPush(`Delegate e2e: ${name}`);
  const hash = hashNow();
  const number = openPr(`Delegate e2e: ${name}`, `${CONTRACT}${verdict(hash, 2)}`);
  const check = await settled(number, { want: ['action_required', 'failure'] });
  return { branch, hash, number, check };
}

await scenario('D1', 'A delegate approval turns a T2 PR green, with a quiet record', async () => {
  const { hash, number, check } = await t2Pr('approve');
  expect(check?.conclusion === 'action_required', `gate before approval: ${check?.conclusion} ${check?.output?.title}`);
  expect(/A delegate may approve this change/.test(check.output.summary), check.output.summary);
  say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
  const green = await settled(number, { want: ['success'] });
  expect(green?.conclusion === 'success', `gate after approval: ${green?.conclusion} ${green?.output?.summary}`);
  const record = await botSays(number, /Delegate approval by/);
  expect(record && !record.body.includes(`@${admin}`), `record: ${record?.body}`);
  return green.output.title;
});

await scenario('D2', 'An admin-only path stays action_required after a delegate approval', async () => {
  const { hash, number, check } = await t2Pr('admin-only', `.pipeline/e2e-${serial}.md`);
  expect(check?.conclusion === 'action_required', `gate: ${check?.conclusion}`);
  say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
  const refusal = await botSays(number, /doesn't count: .*admin-only path/);
  expect(refusal, 'no refusal comment');
  const after = await settled(number, { want: ['action_required', 'success'] });
  expect(after?.conclusion === 'action_required', `gate: ${after?.conclusion}`);
  return 'held for the admin';
});

async function decisionIssue(cls) {
  const bodyFile = join(dir, '.git', 'issue-body.md');
  writeFileSync(bodyFile, `**Class:** ${cls}\n\n**Context:** delegate e2e.\n\n- **A (recommended):** yes\n- **B:** no\n`);
  const url = gh('issue', 'create', '--title', `Decision: delegate e2e ${cls} ${serial}`, '--label', 'decision-needed', '--body-file', bodyFile);
  const number = Number(url.split('/').pop());
  openIssues.push(number);
  expect(await botSays(number, new RegExp(`pipeline:decision-class ${cls}`)), 'the bot recorded no class');
  return number;
}

await scenario('D3', 'A legal decision ignores the delegate; a design one takes it', async () => {
  const legal = await decisionIssue('legal');
  say(legal, '/decide A', delegateEnv);
  expect(await botSays(legal, /doesn't count: .*may not decide legal/), 'no refusal on the legal decision');
  expect(!api(`repos/${repo}/issues/${legal}`).labels.some((l) => l.name === 'decided'), 'legal decision was labelled decided');
  if (!(grantOf(mainConfig()).decide ?? []).includes('design')) return 'legal refused; design not in the grant, so not checked';
  const design = await decisionIssue('design');
  say(design, '/decide A', delegateEnv);
  expect(await botSays(design, /Delegate decision by .* recorded: `A`/), 'the design decision was not recorded');
  return 'legal refused, design recorded';
});

await scenario('D4a', "The delegate can't approve a PR it opened", async () => {
  const branch = freshBranch('own');
  write(`src/auth/own-${serial}.js`, 'export const own = 1;\n');
  delegateCommitAndPush('Delegate e2e: own PR', branch);
  git('fetch', '-q', 'origin', branch);
  git('reset', '-q', '--hard', `origin/${branch}`);
  const hash = hashNow();
  const number = openPr('Delegate e2e: own PR', `${CONTRACT}${verdict(hash, 2)}`, delegateEnv);
  await settled(number, { want: ['action_required', 'failure'] });
  say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
  expect(await botSays(number, /doesn't count: .*(opened this PR|authored or committed)/), 'no refusal');
  const after = await settled(number, { want: ['action_required', 'failure', 'success'] });
  expect(after?.conclusion !== 'success', `gate: ${after?.conclusion}`);
  return after.conclusion;
});

await scenario('D4b', "The delegate can't approve a PR it pushed to", async () => {
  const { branch, number } = await t2Pr('pushed-to');
  write(`src/auth/pushed-${serial}.js`, 'export const pushed = 2;\n');
  delegateCommitAndPush('Delegate e2e: push to a worker branch', branch);
  expect(await botSays(number, /pipeline:delegate-touch kind=push/), 'no touch marker');
  git('fetch', '-q', 'origin', branch);
  git('reset', '-q', '--hard', `origin/${branch}`);
  const hash = hashNow();
  setBody(number, `${CONTRACT}${verdict(hash, 2)}`);
  await settled(number, { want: ['action_required', 'failure'] });
  say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
  expect(await botSays(number, /doesn't count: .*(pushed to it|authored or committed)/), 'no refusal');
  const after = await settled(number, { want: ['action_required', 'failure', 'success'] });
  expect(after?.conclusion !== 'success', `gate: ${after?.conclusion}`);
  return 'touch marked, approval void';
});

await scenario('D5', 'The guard denies a worker the command words and allows the delegate', async () => {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body "/approve 0123456789ab"' }, cwd: dir });
  const hook = (env) => spawnSync('node', [join(dir, '.claude', 'hooks', 'guard.mjs')], { cwd: dir, env, input, encoding: 'utf8' });
  const worker = hook(adminEnv);
  expect(worker.status === 0 && /"deny"/.test(worker.stdout), `worker: ${worker.status} ${worker.stdout}`);
  const gardener = hook(delegateEnv);
  expect(gardener.status === 0 && gardener.stdout === '', `delegate: ${gardener.status} ${scrub(gardener.stdout)}`);
  const release = spawnSync('node', [join(dir, '.claude', 'hooks', 'guard.mjs')], {
    cwd: dir,
    env: delegateEnv,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh release create v9.9.9' }, cwd: dir }),
    encoding: 'utf8',
  });
  expect(/"deny"/.test(release.stdout), 'the delegate could create a release');
  return 'worker denied, delegate allowed, release denied';
});

await scenario('D6', 'Two bad delegate-approved merges suspend delegates, and only an admin lifts it', async () => {
  const merges = [];
  for (const name of ['bad-one', 'bad-two']) {
    const { hash, number, check } = await t2Pr(name);
    expect(check?.conclusion === 'action_required', `${name}: ${check?.conclusion}`);
    say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
    expect((await settled(number, { want: ['success'] }))?.conclusion === 'success', `${name} didn't go green`);
    gh('pr', 'merge', String(number), '--squash', '--auto');
    expect(await waitMerged(number), `${name} didn't merge`);
    openPrs.splice(openPrs.indexOf(number), 1);
    merges.push(stateOf(number).merge_commit_sha);
  }
  for (const sha of merges) {
    freshBranch('revert');
    git('revert', '--no-edit', sha);
    git('push', '-q', '-u', 'origin', 'HEAD');
    const hash = hashNow();
    const number = openPr('Delegate e2e: revert', `${CONTRACT}Revert-of: ${sha}\n${verdict(hash, 2)}`);
    await settled(number, { want: ['action_required', 'success'] });
    say(number, `/approve ${hash.slice(0, 12)}`);
    expect((await settled(number, { want: ['success'] }))?.conclusion === 'success', 'the revert did not go green');
    gh('pr', 'merge', String(number), '--squash', '--auto');
    expect(await waitMerged(number), 'the revert did not merge');
    openPrs.splice(openPrs.indexOf(number), 1);
  }
  let issue = null;
  const deadline = Date.now() + 600000;
  while (!issue && Date.now() < deadline) {
    issue = api(`repos/${repo}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=50`).find((i) => i.title.startsWith('Delegates suspended'));
    if (!issue) await sleep(10000);
  }
  expect(issue, 'no suspension issue opened');
  say(issue.number, '/rearm', delegateEnv);
  expect(await botSays(issue.number, /Only an admin can lift/), 'the delegate re-arm was not refused');
  expect(api(`repos/${repo}/issues/${issue.number}`).state === 'open', 'the delegate lifted it');
  say(issue.number, '/rearm');
  expect(await botSays(issue.number, /Delegates are back on/), 'the admin re-arm was not recorded');
  return `suspended in #${issue.number}, lifted by ${admin}`;
});

await scenario('D7', 'release.yml refuses the delegate', async () => {
  const before = Date.now();
  const dispatch = run('gh', ['workflow', 'run', 'release.yml', '-f', 'promote=v0.0.0-delegate-e2e'], { env: delegateEnv });
  if (!dispatch.ok) return `refused at dispatch: ${dispatch.out.split('\n')[0]}`;
  let runInfo = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    runInfo = api(`repos/${repo}/actions/workflows/release.yml/runs?per_page=10`).workflow_runs.find(
      (r) => r.actor?.login === delegate.login && Date.parse(r.created_at) >= before - 60000,
    );
    if (runInfo?.status === 'completed') break;
    await sleep(8000);
  }
  expect(runInfo?.status === 'completed', 'the dispatched run did not finish');
  const jobs = api(`repos/${repo}/actions/runs/${runInfo.id}/jobs`).jobs;
  expect(jobs.every((job) => job.conclusion === 'skipped'), `jobs ran: ${jobs.map((j) => `${j.name}=${j.conclusion}`).join(', ')}`);
  return `run ${runInfo.id}: every job skipped`;
});

// The pipeline must behave as before with no `delegates` key. This takes the key
// off main (an admin-only change the admin approves), checks, and puts it back.
async function setDelegates(delegates) {
  freshBranch('config');
  const config = JSON.parse(readFileSync(join(dir, 'pipeline.config.json'), 'utf8'));
  if (delegates === undefined) delete config.delegates;
  else config.delegates = delegates;
  write('pipeline.config.json', `${JSON.stringify(config, null, 2)}\n`);
  commitAndPush(delegates === undefined ? 'Delegate e2e: remove delegates' : 'Delegate e2e: restore delegates');
  const hash = hashNow();
  const number = openPr('Delegate e2e: config', `${CONTRACT}${verdict(hash, 2)}`);
  await settled(number, { want: ['action_required', 'success'] });
  say(number, `/approve ${hash.slice(0, 12)}`);
  expect((await settled(number, { want: ['success'] }))?.conclusion === 'success', 'the config change did not go green');
  gh('pr', 'merge', String(number), '--squash', '--auto');
  expect(await waitMerged(number), 'the config change did not merge');
  openPrs.splice(openPrs.indexOf(number), 1);
}

await scenario('D8', 'With no delegates key, a delegate account is nobody', async () => {
  const saved = mainConfig().delegates;
  await setDelegates(undefined);
  try {
    const { hash, number, check } = await t2Pr('no-delegates');
    expect(!/delegate/i.test(check?.output?.summary ?? ''), `the summary mentions delegates: ${check?.output?.summary}`);
    say(number, `/approve ${hash.slice(0, 12)}`, delegateEnv);
    await sleep(60000);
    const after = gateCheck(headOf(number));
    expect(after?.conclusion === 'action_required', `gate: ${after?.conclusion}`);
    expect(!comments(number).some((c) => c.user.login === 'github-actions[bot]'), 'the bot answered a non-delegate');
    return 'approval ignored, no bot reply';
  } finally {
    cleanup();
    await setDelegates(saved);
  }
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exitCode = passed === results.length ? 0 : 1;
