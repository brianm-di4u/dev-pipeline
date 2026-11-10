// Delegate approvers, PR 9: fixes from the review of the whole stack. Each test
// names the finding it covers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BOT_USER, fakeGitHub, posted } from './fixtures/fake-github.mjs';
import { checkCommand } from '../template/.claude/hooks/guard.mjs';
import { baseConfig } from '../template/.pipeline/garden.mjs';
import { checkRunBody, delegateInputs, reevaluate } from '../template/.pipeline/gate.mjs';
import { delegateBarriers, findApproval, renderClassMarker } from '../template/.pipeline/lib/contract.mjs';
import { gateRunProblems } from '../template/.pipeline/lib/delegates.mjs';
import { approvalOfCheck, evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { classify } from '../template/.pipeline/lib/tier.mjs';
import { delegatesLifted, delegatesPostMerge, issueEvent, postMerge, previousRearm } from '../template/.pipeline/monitor.mjs';

const config = { admins: ['owner'], breaker: { window: 20, maxFailures: 3 }, tiers: { t2Paths: ['.github/**'], t0Paths: [], t0Exclude: [] }, merge: { t0: 'auto', t1: 'auto', t2: 'human' } };
const delegated = (grant = {}) => ({ ...config, delegates: [{ login: 'gardener', approve: true, rearm: true, decide: ['design'], ...grant }] });
const at = (h, m = 0) => `2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const say = (body, login, time = at(10)) => ({ id: Date.parse(time) / 1000, body, user: { login, type: 'User' }, author_association: 'COLLABORATOR', created_at: time, updated_at: time });
const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' });

// ---------------------------------------------------------------------------
// A4: workflows and actions need approveWorkflows.
// ---------------------------------------------------------------------------

const ctxFor = (paths, cfg) => ({
  flags: classify({ changes: paths.map(change), config: cfg, author: 'owner' }).flags,
  author: 'owner',
  commitLogins: ['owner'],
  touches: [],
  suspended: false,
  suspensions: [],
});

test('A4: a workflow or action change needs a grant with approveWorkflows; agents and council workflows do not', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml']) {
    const reasons = delegateBarriers(delegated(), 'gardener', ctxFor([path], delegated()));
    assert.ok(reasons.some((r) => /no approveWorkflows grant/.test(r)), path);
    assert.deepEqual(delegateBarriers(delegated({ approveWorkflows: true }), 'gardener', ctxFor([path], delegated({ approveWorkflows: true }))), [], path);
  }
  for (const path of ['.claude/agents/council-x.md', '.claude/workflows/round.js', '.github/dependabot.yml']) {
    assert.deepEqual(delegateBarriers(delegated(), 'gardener', ctxFor([path], delegated())), [], path);
  }
  // The floor's own workflows stay admin-only even with the grant.
  const gate = delegateBarriers(delegated({ approveWorkflows: true }), 'gardener', ctxFor(['.github/workflows/gate.yml'], delegated({ approveWorkflows: true })));
  assert.ok(gate.some((r) => /admin-only path/.test(r)));
});

// ---------------------------------------------------------------------------
// A1 and C13: who opened a decision issue, and its label history.
// ---------------------------------------------------------------------------

const labelEvent = (name, login, time) => ({ event: 'labeled', label: { name }, actor: { login }, created_at: time });
const labelledIssue = (user, body) => ({ action: 'labeled', label: { name: 'decision-needed' }, issue: { number: 7, body, labels: [{ name: 'decision-needed' }], user: { login: user } } });

test("A1: a decision issue an outsider opened is the admin's, and gets no delegate notice", async () => {
  const client = fakeGitHub({ events: { 7: [labelEvent('decision-needed', 'stranger', at(8))] } });
  await issueEvent(client, 'o/r', delegated(), 'issues', labelledIssue('stranger', '**Class:** design'));
  const [body] = posted(client, '/comments').map((b) => b.body);
  assert.match(body, /^@owner a decision is needed here\. An admin did not open it/);
  assert.match(body, /pipeline:decision-class design/);
});

test('C13: a relabel after the record was deleted records the issue as unclassified', async () => {
  const events = [labelEvent('decision-needed', 'owner', at(8)), labelEvent('decision-needed', 'gardener', at(9))];
  const client = fakeGitHub({ events: { 7: events } });
  await issueEvent(client, 'o/r', delegated(), 'issues', labelledIssue('owner', '**Class:** design'));
  const [body] = posted(client, '/comments').map((b) => b.body);
  assert.match(body, /pipeline:decision-class unclassified/);
  assert.doesNotMatch(body, /A delegate \(gardener\)/);
});

// ---------------------------------------------------------------------------
// C8: republished checks.
// ---------------------------------------------------------------------------

const run = (extra) => ({ path: '.github/workflows/post-merge.yml', event: 'push', head_branch: 'main', repository: { full_name: 'o/r' }, run_started_at: at(10), updated_at: at(10, 5), ...extra });
const check = (externalId) => ({ app: { slug: 'github-actions' }, external_id: externalId, completed_at: at(10, 2) });

test("C8: a re-publish from the pipeline's own workflows on the default branch is genuine", () => {
  assert.deepEqual(gateRunProblems(check('republish:9'), run(), 'o/r', 'main'), []);
  assert.deepEqual(gateRunProblems(check('republish:9'), run({ path: '.github/workflows/audit.yml', event: 'schedule' }), 'o/r', 'main'), []);
  assert.deepEqual(gateRunProblems(check('republish:9'), run({ path: '.github/workflows/decisions.yml', event: 'issue_comment' }), 'o/r', 'main'), []);
  assert.ok(gateRunProblems(check('republish:9'), run({ path: '.github/workflows/audit.yml', event: 'workflow_dispatch', head_branch: 'evil' }), 'o/r', 'main').some((p) => /ran on evil/.test(p)));
  assert.ok(gateRunProblems(check('republish:9'), run({ path: '.github/workflows/evil.yml' }), 'o/r', 'main').some((p) => /re-publish came from/.test(p)));
  assert.ok(gateRunProblems(check('republish:9'), run({ event: 'workflow_dispatch' }), 'o/r', 'main').some((p) => /re-publish came from a workflow_dispatch run/.test(p)));
  // A plain stamp from post-merge is still not the gate.
  assert.ok(gateRunProblems(check('9'), run(), 'o/r', 'main').some((p) => /came from \.github\/workflows\/post-merge\.yml/.test(p)));
});

test('C8: a re-publish stamps its check as one', () => {
  const input = { pr: { head: 'h', url: 'u' }, config: delegated() };
  const result = { status: 'completed', conclusion: 'action_required', title: 't', summary: 's' };
  assert.equal(checkRunBody(input, result, '77', { republish: true }).external_id, 'republish:77');
  assert.equal(checkRunBody(input, result, '77').external_id, '77');
});

// ---------------------------------------------------------------------------
// C9: an admin's lift re-runs the gate for the PRs it held.
// ---------------------------------------------------------------------------

const suspendIssue = (extra) => ({ number: 30, title: 'Delegates suspended: x', labels: [{ name: 'pipeline:delegate-suspended' }], user: BOT_USER, ...extra });
const heldPulls = [{ number: 7, state: 'open' }, { number: 8, state: 'open' }];
const heldComments = { 7: [say('/approve abcdef012345', 'gardener')], 8: [say('/approve abcdef012345', 'owner')] };

test('C9: after an admin lifts a suspension, PRs holding a delegate approval are re-run', async () => {
  const lifted = fakeGitHub({ issues: [suspendIssue({ state: 'closed' })], comments: { 30: [say('/rearm', 'owner', at(11))], ...heldComments }, pulls: heldPulls });
  const rerun = [];
  const result = await delegatesLifted(lifted, 'o/r', delegated(), async (_c, _r, numbers) => (rerun.push(...numbers), []));
  assert.deepEqual(rerun, [7]);
  assert.ok(result.republished);
  const still = fakeGitHub({ issues: [suspendIssue()], comments: heldComments, pulls: heldPulls });
  assert.deepEqual(await delegatesLifted(still, 'o/r', delegated(), async () => assert.fail('re-ran while suspended')), { skipped: 'delegates are still suspended' });
  assert.deepEqual(await delegatesLifted(still, 'o/r', config), { skipped: 'no delegates configured' });
});

// ---------------------------------------------------------------------------
// C10: whose approval the gate relied on, recorded in its check.
// ---------------------------------------------------------------------------

test("C10: with a delegate, a passing check records whose approval it relied on; without one, nothing", () => {
  const hash = 'abcdef012345'.padEnd(64, '0');
  const verdict = `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`;
  const input = (cfg, comments) => ({
    pr: { author: 'owner', body: `## Testing\nx\n## Risk\nx\n## How to revert\nx\n${verdict}`, draft: false, base: 'main' },
    changes: [change('.github/dependabot.yml')],
    hash,
    config: cfg,
    verify: 'success',
    comments,
    commitLogins: ['owner'],
    touches: [],
    suspended: false,
    suspensions: [],
  });
  const delegateOk = evaluateGate(input(delegated(), [say('/approve abcdef012345', 'gardener')]));
  assert.deepEqual(approvalOfCheck(delegateOk.summary), { role: 'delegate', login: 'gardener' });
  const adminOk = evaluateGate(input(delegated(), [say('/approve abcdef012345', 'gardener'), say('/approve abcdef012345', 'owner')]));
  assert.equal(approvalOfCheck(adminOk.summary).role, 'delegate', 'the first approval that counts is the one the gate relied on');
  const plain = evaluateGate(input(config, [say('/approve abcdef012345', 'owner')]));
  assert.equal(approvalOfCheck(plain.summary), null);
  assert.doesNotMatch(plain.summary, /pipeline:approval/);
});

// ---------------------------------------------------------------------------
// C11: re-arms recorded by label, judged by their own time.
// ---------------------------------------------------------------------------

const breaker = (number, extra) => ({ number, title: 'Circuit breaker tripped: T1 auto-merge is suspended', labels: [{ name: 'pipeline:breaker' }], user: BOT_USER, state: 'closed', ...extra });
const offer = { id: 1, body: 'x\n\n<!-- pipeline:delegate-rearm-ok -->', user: BOT_USER, created_at: at(9), updated_at: at(9) };
const free = { suspended: false, suspensions: [] };

test('C11: the previous re-arm comes from the bot label, and a breaker closed with no valid re-arm counts as a delegate re-arm', async () => {
  const labelled = fakeGitHub({ issues: [breaker(5)], events: { 5: [labelEvent('pipeline:breaker', 'github-actions[bot]', at(8)), labelEvent('pipeline:delegate-rearmed', 'github-actions[bot]', at(10))] } });
  assert.deepEqual(await previousRearm(labelled, 'o/r', delegated(), breaker(5), free), { role: 'delegate' }, 'the comment was deleted, the label event stays');
  const admin = fakeGitHub({ issues: [breaker(5)], comments: { 5: [say('/rearm', 'owner')] } });
  assert.deepEqual(await previousRearm(admin, 'o/r', delegated(), breaker(5), free), { role: 'admin' });
  const nobody = fakeGitHub({ issues: [breaker(5)] });
  assert.deepEqual(await previousRearm(nobody, 'o/r', delegated(), breaker(5), free), { role: 'delegate' });
  assert.equal(await previousRearm(nobody, 'o/r', delegated(), null, free), null);
});

test('C11: an accepted delegate re-arm is labelled on the breaker issue', async () => {
  const rearm = say('/rearm', 'gardener');
  const client = fakeGitHub({ issues: [breaker(5, { state: 'open' })], comments: { 5: [offer, rearm] } });
  const event = { action: 'created', comment: rearm, issue: { ...breaker(5, { state: 'open' }) } };
  await issueEvent(client, 'o/r', delegated(), 'issue_comment', event, free);
  assert.deepEqual(posted(client, '/issues/5/labels'), [{ labels: ['pipeline:delegate-rearmed'] }]);
});

// ---------------------------------------------------------------------------
// C14: touches from GitHub's own records, and a null commit author.
// ---------------------------------------------------------------------------

test("C14: pushes and body edits are read from GitHub's own records, after the PR opened", async () => {
  const pr = { created_at: at(9), head: { ref: 'feature/x', repo: { full_name: 'o/r' } } };
  const client = fakeGitHub({
    routes: {
      'LIST /repos/o/r/activity': [
        { activity_type: 'push', actor: { login: 'gardener' }, timestamp: at(8) },
        { activity_type: 'push', actor: { login: 'owner' }, timestamp: at(10) },
        { activity_type: 'force_push', actor: { login: 'Gardener' }, timestamp: at(11) },
      ],
    },
    graphql: () => ({
      data: { repository: { pullRequest: { userContentEdits: { nodes: [
        { editedAt: at(9), editor: { login: 'gardener' } },
        { editedAt: at(12), editor: { login: 'owner' } },
        { editedAt: at(13), editor: { login: 'gardener' } },
      ] } } } },
    }),
  });
  const inputs = await delegateInputs(client, 'o/r', 8, [], { pr, config: delegated() });
  assert.deepEqual(inputs.touches.map((t) => `${t.kind}:${t.login}`), ['push:Gardener', 'body:gardener']);
  assert.ok(client.calls.some((c) => c.path.startsWith('/repos/o/r/activity?ref=refs%2Fheads%2Ffeature%2Fx')));
  // A fork's branch isn't in this repo's activity log.
  const fork = await delegateInputs(client, 'o/r', 8, [], { pr: { ...pr, head: { ref: 'x', repo: { full_name: 'other/r' } } }, config: delegated() });
  assert.deepEqual(fork.touches.map((t) => t.kind), ['body']);
});

test("C14: an unreadable history voids a delegate's approval, and leaves the gate running for an admin's", async () => {
  const pr = { created_at: at(9), head: { ref: 'x', repo: { full_name: 'o/r' } } };
  const client = fakeGitHub({ graphql: () => ({ errors: [{ message: 'no access' }] }) });
  const inputs = await delegateInputs(client, 'o/r', 8, [], { pr, config: delegated() });
  assert.equal(inputs.historyUnreadable, true);
  const ctx = { flags: { adminOnly: [], symlinks: [], scripts: [], external: false, workflows: [] }, author: 'owner', commitLogins: [], touches: [], historyUnreadable: true, suspended: false, suspensions: [] };
  assert.ok(delegateBarriers(delegated(), 'gardener', ctx).some((r) => /push and edit history/.test(r)));
  assert.equal(findApproval([say('/approve abcdef012345', 'owner')], delegated(), 'abcdef012345'.padEnd(64, '0'), ctx).role, 'admin');
});

test('C14: a commit with no linked GitHub user is not a barrier', async () => {
  const client = fakeGitHub({ commits: { 8: [{ author: null, committer: null }, { author: { login: 'owner' }, committer: { login: 'web-flow' } }] } });
  const inputs = await delegateInputs(client, 'o/r', 8, []);
  assert.deepEqual(inputs.commitLogins, ['owner', 'web-flow']);
  const ctx = { flags: { adminOnly: [], symlinks: [], scripts: [], external: false, workflows: [] }, author: 'owner', commitLogins: inputs.commitLogins, touches: [], suspended: false, suspensions: [] };
  assert.deepEqual(delegateBarriers(delegated(), 'gardener', ctx), []);
});

// ---------------------------------------------------------------------------
// C15 and B7: the delegate work runs apart, in order, and smoke never reaches it.
// ---------------------------------------------------------------------------

test('C15: a forged-gate error still lets the suspension check run, and the error is reported', async () => {
  const client = fakeGitHub();
  client.get = async () => {
    throw new Error('HTTP 502');
  };
  await assert.rejects(delegatesPostMerge(client, 'o/r', delegated(), 'm1', async () => []), /forged-gate check: HTTP 502/);
  assert.ok(client.calls.some((c) => c.path.startsWith('/repos/o/r/pulls?state=closed')), 'the suspension check ran');
});

test('C15: a suspension the forged-gate check opened is not opened twice', async () => {
  const configFile = { content: Buffer.from(JSON.stringify(delegated())).toString('base64') };
  const client = fakeGitHub({
    routes: {
      'GET /repos/o/r/commits/m1': { parents: [{ sha: 'p1' }] },
      'GET /repos/o/r/contents/pipeline.config.json': configFile,
      'LIST /repos/o/r/commits/m1/pulls': [{ number: 12, merged_at: at(10), merge_commit_sha: 'm1', head: { sha: 'h12' }, base: { repo: { default_branch: 'main' } } }],
      'LIST /repos/o/r/commits/h12/check-runs': [{ id: 1, name: 'pipeline/gate', status: 'completed', app: { slug: 'evil' }, external_id: '', completed_at: at(10) }],
    },
  });
  const result = await delegatesPostMerge(client, 'o/r', delegated(), 'm1', async () => []);
  assert.equal(result.gate.ok, false);
  assert.equal(result.delegates.alreadySuspended, true);
  assert.equal(posted(client).filter((b) => /^Delegates suspended/.test(b.title ?? '')).length, 1);
});

test('B7: post-merge, and smoke through it, never re-run the gate or check provenance', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '5', GITHUB_EVENT_NAME: 'schedule' });
  try {
    const client = fakeGitHub({ pulls: heldPulls, comments: heldComments });
    await postMerge(client, 'o/r', delegated(), ['--result', 'smoke-failure']);
    assert.equal(client.calls.some((c) => /check-runs|\/commits\/|actions\/runs/.test(c.path)), false);
  } finally {
    for (const key of ['GITHUB_SHA', 'GITHUB_SERVER_URL', 'GITHUB_RUN_ID', 'GITHUB_EVENT_NAME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('B7: a re-run that fails, and then cannot publish its error, reports instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reevaluate'));
  try {
    const client = fakeGitHub({ pulls: [{ number: 7, state: 'open', head: { sha: 'h7' }, base: { repo: { default_branch: 'main' } } }] });
    const realPost = client.post;
    client.post = async (path, body) => {
      if (path.endsWith('/check-runs')) throw new Error('HTTP 403');
      return realPost(path, body);
    };
    const results = await reevaluate(client, 'o/r', [7], dir);
    assert.deepEqual(results, [{ number: 7, conclusion: 'error' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D16: the inbox reads policy from the default branch.
// ---------------------------------------------------------------------------

test("D16: the inbox's config comes from the default branch through the API", async () => {
  const client = fakeGitHub({ routes: { 'GET /repos/o/r/contents/pipeline.config.json': { content: Buffer.from(JSON.stringify({ ...delegated(), verify: {} })).toString('base64') } } });
  const cfg = await baseConfig(client, 'o/r', 'main');
  assert.equal(cfg.delegates[0].login, 'gardener');
  assert.ok(client.calls.some((c) => c.path === '/repos/o/r/contents/pipeline.config.json?ref=main'));
});

// ---------------------------------------------------------------------------
// Guard: a call inside a subshell is still checked, for every session.
// ---------------------------------------------------------------------------

test('a command word posted from inside a subshell is denied, with or without delegates', () => {
  const nobody = { currentBranch: () => 'feature/x', isOwnPr: () => true, delegateMayPost: () => false, isDelegateSession: () => false, localDelegates: () => false };
  assert.match(checkCommand('echo $(gh pr comment 5 --body "/approve abcdef012345")', nobody), /Only a human posts/);
  assert.match(checkCommand('x=`gh pr comment 5 --body "/approve abcdef012345"`', nobody), /Only a human posts/);
  assert.equal(checkCommand('echo $(gh pr view 5 --json title)', nobody), null);
});

// ---------------------------------------------------------------------------
// D17: pr-wait keeps only valid delegate logins.
// ---------------------------------------------------------------------------

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test('D17: pr-wait drops a delegate entry whose login is not a GitHub login', { skip: !python && 'python not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait-login'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify({ admins: ['Owner'], delegates: [{ login: 'has space', direct: true }, { login: '-bad', direct: true }, { login: 'owner', direct: true }, { login: 'ok-one', direct: true }] }));
    const code = [
      'import importlib.machinery, importlib.util, json',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
      'loader.exec_module(mod)',
      'print(json.dumps(sorted(mod.DELEGATES)))',
    ].join('\n');
    const out = spawnSync(python, ['-c', code], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), ['ok-one']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D20: the setup script refuses a tracked or linked settings file.
// ---------------------------------------------------------------------------

const script = fileURLToPath(new URL('../tools/setup-delegate.ps1', import.meta.url));
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
const writeWith = (dir) =>
  spawnSync('pwsh', ['-NoProfile', '-Command', `. ${quote(script)}; $s = ConvertTo-SecureString 'ghp_TESTONLY' -AsPlainText -Force; Write-DelegateSettings ${quote(dir)} $s 'm'`], {
    encoding: 'utf8',
  });

test('D20: the setup script refuses a settings file that git tracks', { skip: !pwsh && 'pwsh not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-tracked'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}\n');
    spawnSync('git', ['-C', dir, 'add', '-f', '.claude/settings.local.json']);
    const result = writeWith(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /tracked by git/);
    assert.equal(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'), '{}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D20: the setup script refuses a linked .claude folder', { skip: !pwsh && 'pwsh not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-linked'));
  try {
    spawnSync('git', ['init', '-q', join(dir, 'clone')]);
    mkdirSync(join(dir, 'elsewhere'));
    const kind = process.platform === 'win32' ? 'Junction' : 'SymbolicLink';
    const made = spawnSync('pwsh', ['-NoProfile', '-Command', `New-Item -ItemType ${kind} -Path ${quote(join(dir, 'clone', '.claude'))} -Target ${quote(join(dir, 'elsewhere'))} | Out-Null`], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const result = writeWith(join(dir, 'clone'));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /is a link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
