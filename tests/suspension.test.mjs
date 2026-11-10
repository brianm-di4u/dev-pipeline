// Delegate approvers, PR 4: automatic suspension, the admin lift, and the check
// that a merged PR's gate result came from the real gate.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BOT_USER, fakeGitHub, posted } from './fixtures/fake-github.mjs';
import { evaluateSuspension, gateRunProblems, redIssueSha, renderRedMarker } from '../template/.pipeline/lib/delegates.mjs';
import { readSuspension } from '../template/.pipeline/lib/state.mjs';
import { checkRunBody } from '../template/.pipeline/gate.mjs';
import { audit, checkDelegates, checkGateProvenance, issueEvent, postMerge } from '../template/.pipeline/monitor.mjs';

const config = { admins: ['owner'], breaker: { window: 20, maxFailures: 3 }, tiers: { t2Paths: [] }, merge: {} };
const delegated = (extra = {}) => ({ ...config, delegates: [{ login: 'gardener', approve: true }], ...extra });

const hashOf = (n) => `${String(n).padStart(4, '0')}`.padEnd(64, 'a');
const verdict = (n, tier = 2) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hashOf(n), tier, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`;
const sha = (n) => `f${n}f`.padEnd(40, '0');
const merge = (n, day = 10, extra = {}) => ({ number: n, merged_at: `2026-11-${day}T00:00:00Z`, merge_commit_sha: sha(n), state: 'closed', body: verdict(n), ...extra });
const revertOf = (n, target, day = 11) => ({ ...merge(n, day), body: `Revert-of: ${sha(target)}` });
const approve = (n, login, extra = {}) => ({
  body: `/approve ${hashOf(n).slice(0, 12)}`,
  user: { login, type: 'User' },
  created_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T10:00:00Z',
  ...extra,
});
const redIssue = (number, target, { marker = true } = {}) => ({
  number,
  title: `Main is red at ${sha(target).slice(0, 7)}`,
  body: marker ? `verify failed\n\n${renderRedMarker(sha(target))}` : 'verify failed',
  created_at: '2026-11-11T00:00:00Z',
  labels: [{ name: 'pipeline:main-red' }],
  user: BOT_USER,
  state: 'closed',
});

// ---------------------------------------------------------------------------
// evaluateSuspension
// ---------------------------------------------------------------------------

// The PRs the bot labelled delegate-approved when they merged.
const labelled = (...numbers) => new Set(numbers);

test('two delegate-approved merges that went bad suspend delegates', () => {
  const merges = [merge(1), merge(2), merge(3), revertOf(4, 1)];
  const result = evaluateSuspension({ merges, delegateApproved: labelled(1, 2), redIssues: [redIssue(9, 2)], config: delegated() });
  assert.equal(result.suspend, true);
  assert.deepEqual(result.bad.map((b) => [b.number, b.reverted, b.red]), [
    [2, false, [9]],
    [1, true, []],
  ]);
  assert.deepEqual(result.approved.sort(), [1, 2]);
});

test('one bad merge, or bad merges the bot did not label delegate-approved, do not suspend', () => {
  const merges = [merge(1), merge(2), revertOf(4, 1), revertOf(5, 2)];
  const one = evaluateSuspension({ merges, delegateApproved: labelled(1), redIssues: [], config: delegated() });
  assert.equal(one.suspend, false);
  assert.equal(one.failures, 1);
  assert.equal(evaluateSuspension({ merges, delegateApproved: labelled(), redIssues: [], config: delegated() }).failures, 0);
});

test('a merge both reverted and red counts once, and old issues map by their title', () => {
  const merges = [merge(1), revertOf(4, 1)];
  const result = evaluateSuspension({
    merges,
    delegateApproved: labelled(1),
    redIssues: [redIssue(9, 1, { marker: false }), redIssue(10, 1)],
    config: delegated(),
  });
  assert.equal(result.failures, 1);
  assert.deepEqual(result.bad[0].red, [9, 10]);
  assert.equal(redIssueSha({ title: 'Main is red at abc1234', body: '' }), 'abc1234');
  assert.equal(redIssueSha({ title: 'Main is red at abc1234', body: renderRedMarker('abc1234'.padEnd(40, '9')) }), 'abc1234'.padEnd(40, '9'));
});

test('the limit is configurable, the window counts ordinary merges, and a lift starts the count over', () => {
  const merges = [merge(1), merge(2), revertOf(4, 1), revertOf(5, 2)];
  const delegateApproved = labelled(1, 2);
  assert.equal(evaluateSuspension({ merges, delegateApproved, redIssues: [], config: delegated({ breaker: { window: 20, delegateMaxFailures: 3 } }) }).suspend, false);
  assert.equal(evaluateSuspension({ merges, delegateApproved, redIssues: [], config: delegated(), since: '2026-11-10T12:00:00Z' }).suspend, false);
  // Docs merges (T0) don't count and can't push approved merges out of the window.
  const docs = Array.from({ length: 30 }, (_, i) => merge(100 + i, 12, { body: verdict(100 + i, 0) }));
  assert.equal(evaluateSuspension({ merges: [...merges, ...docs], delegateApproved, redIssues: [], config: delegated() }).suspend, true);
  const recent = Array.from({ length: 20 }, (_, i) => merge(200 + i, 20));
  assert.equal(evaluateSuspension({ merges: [...merges, ...recent], delegateApproved, redIssues: [], config: delegated() }).suspend, false);
});

// ---------------------------------------------------------------------------
// checkDelegates and the admin lift
// ---------------------------------------------------------------------------

const approvedLabel = [{ event: 'labeled', label: { name: 'pipeline:delegate-approved' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-11-12T00:00:00Z' }];
const badHistory = () => ({
  pulls: [merge(1), merge(2), revertOf(4, 1), revertOf(5, 2), { number: 7, state: 'open', head: { sha: 'h7' } }, { number: 8, state: 'open', head: { sha: 'h8' } }],
  comments: { 1: [approve(1, 'gardener')], 2: [approve(2, 'gardener')], 7: [approve(7, 'gardener')], 8: [approve(8, 'owner')] },
  // The bot labelled #1 and #2 when they merged. Deleting the approvals later changes nothing.
  events: { 1: approvedLabel, 2: approvedLabel },
});

test('without delegates, nothing about delegates is read or written', async () => {
  const client = fakeGitHub(badHistory());
  assert.equal(await checkDelegates(client, 'o/r', config), null);
  assert.equal(await checkGateProvenance(client, 'o/r', config, sha(1)), null);
  assert.deepEqual(client.calls, []);
});

test('a suspension opens a bot issue and re-publishes the gate for open PRs a delegate approved', async () => {
  const client = fakeGitHub(badHistory());
  const republished = [];
  const result = await checkDelegates(client, 'o/r', delegated(), async (_c, _r, numbers) => {
    republished.push(...numbers);
    return numbers.map((number) => ({ number, conclusion: 'action_required' }));
  });
  assert.equal(result.suspend, true);
  const [issue] = posted(client).filter((body) => body.title);
  assert.match(issue.title, /^Delegates suspended: 2 delegate-approved merges went bad$/);
  assert.deepEqual(issue.labels, ['pipeline:delegate-suspended']);
  assert.match(issue.body, /^@owner /);
  assert.match(issue.body, /#2: reverted/);
  assert.deepEqual(republished, [7], 'only the open PR holding a delegate approval');

  const state = await readSuspension(client, 'o/r', delegated());
  assert.equal(state.suspended, true);
  // Already suspended: nothing new.
  const again = await checkDelegates(client, 'o/r', delegated(), async () => []);
  assert.equal(again.alreadySuspended, true);
});

const suspendIssue = { number: 30, title: 'Delegates suspended: x', labels: [{ name: 'pipeline:delegate-suspended' }], user: BOT_USER, body: '' };
const commentOn = (body, login) => ({
  action: 'created',
  comment: { body, user: { login, type: 'User' }, created_at: '2026-11-09T11:00:00Z', updated_at: '2026-11-09T11:00:00Z' },
  issue: suspendIssue,
});

test('only an admin /rearm lifts a suspension', async () => {
  const lift = fakeGitHub({ issues: [suspendIssue] });
  await issueEvent(lift, 'o/r', delegated(), 'issue_comment', commentOn('/rearm', 'owner'), { suspended: true, suspensions: [] });
  assert.match(posted(lift, '/comments')[0].body, /^Delegates are back on\./);
  assert.ok(lift.calls.some((c) => c.method === 'PATCH' && c.body.state === 'closed'));

  const refused = fakeGitHub({ issues: [suspendIssue] });
  await issueEvent(refused, 'o/r', delegated({ delegates: [{ login: 'gardener', approve: true, rearm: true }] }), 'issue_comment', commentOn('/rearm', 'gardener'), {});
  assert.deepEqual(posted(refused, '/comments').map((b) => b.body), ['Only an admin can lift a delegate suspension.']);
  assert.equal(refused.calls.some((c) => c.method === 'PATCH'), false);

  const noDelegates = fakeGitHub({ issues: [suspendIssue] });
  await issueEvent(noDelegates, 'o/r', config, 'issue_comment', commentOn('/rearm', 'owner'));
  assert.deepEqual(noDelegates.calls, [], 'without delegates the suspension issue means nothing');
});

// ---------------------------------------------------------------------------
// The forged-gate check
// ---------------------------------------------------------------------------

const goodRun = {
  id: 77,
  path: '.github/workflows/gate.yml',
  event: 'issue_comment',
  repository: { full_name: 'o/r' },
  run_started_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T10:02:00Z',
};
const gateCheck = (extra = {}) => ({
  id: 900,
  name: 'pipeline/gate',
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
  external_id: '77',
  completed_at: '2026-11-09T10:01:00Z',
  ...extra,
});

test('a gate check from gate.yml on the default branch passes', () => {
  assert.deepEqual(gateRunProblems(gateCheck(), goodRun, 'o/r'), []);
  assert.deepEqual(gateRunProblems(gateCheck(), { ...goodRun, path: '.github/workflows/gate.yml@refs/heads/main' }, 'o/r'), []);
});

for (const [name, check, run, why] of [
  ['another workflow', gateCheck(), { ...goodRun, path: '.github/workflows/evil.yml' }, /came from \.github\/workflows\/evil\.yml/],
  ['a push-triggered copy of gate.yml', gateCheck(), { ...goodRun, event: 'push' }, /triggered by push/],
  ['another app', gateCheck({ app: { slug: 'evil-app' } }), goodRun, /written by evil-app/],
  ['no run id', gateCheck({ external_id: '' }), null, /no gate run id/],
  ['a run that cannot be found', gateCheck(), null, /could not be found/],
  ['a check written outside its run', gateCheck({ completed_at: '2026-11-09T12:00:00Z' }), goodRun, /outside its run/],
  ['a run in another repo', gateCheck(), { ...goodRun, repository: { full_name: 'x/fork' } }, /belongs to x\/fork/],
]) {
  test(`a gate check is suspect when it comes from ${name}`, () => {
    assert.ok(gateRunProblems(check, run, 'o/r').some((p) => why.test(p)));
  });
}

const configFile = (cfg) => ({ content: Buffer.from(JSON.stringify(cfg)).toString('base64') });
const provenanceRoutes = (parentConfig, check, run = goodRun) => ({
  'GET /repos/o/r/commits/m1': { sha: 'm1', parents: [{ sha: 'p1' }] },
  'GET /repos/o/r/contents/pipeline.config.json': configFile(parentConfig),
  'LIST /repos/o/r/commits/m1/pulls': [{ number: 12, merged_at: '2026-11-09T10:05:00Z', merge_commit_sha: 'm1', head: { sha: 'h12' } }],
  'LIST /repos/o/r/commits/h12/check-runs': check ? [check] : [],
  'GET /repos/o/r/actions/runs/77': run,
});

test('the forged-gate check skips merges judged before delegates were configured', async () => {
  const client = fakeGitHub({ routes: provenanceRoutes(config, gateCheck({ external_id: '' })) });
  assert.deepEqual(await checkGateProvenance(client, 'o/r', delegated(), 'm1', async () => []), { skipped: 'the gate for this merge predates delegates' });
});

test('a genuine gate check on the merged head is accepted', async () => {
  const client = fakeGitHub({ routes: provenanceRoutes(delegated(), gateCheck()) });
  assert.deepEqual(await checkGateProvenance(client, 'o/r', delegated(), 'm1', async () => []), { ok: true, pr: 12, approval: null });
  assert.equal(posted(client).length, 0);
});

test('a merge the gate let through on a delegate approval is labelled at merge', async () => {
  const summary = 'Approved by gardener, a delegate.\n\n<!-- pipeline:approval role=delegate login=gardener -->';
  const client = fakeGitHub({ routes: provenanceRoutes(delegated(), gateCheck({ output: { summary } })) });
  const result = await checkGateProvenance(client, 'o/r', delegated(), 'm1', async () => []);
  assert.deepEqual(result.approval, { role: 'delegate', login: 'gardener' });
  assert.deepEqual(posted(client, '/issues/12/labels'), [{ labels: ['pipeline:delegate-approved'] }]);
  // An admin-approved merge isn't labelled.
  const admin = fakeGitHub({ routes: provenanceRoutes(delegated(), gateCheck({ output: { summary: '<!-- pipeline:approval role=admin login=owner -->' } })) });
  await checkGateProvenance(admin, 'o/r', delegated(), 'm1', async () => []);
  assert.deepEqual(posted(admin, '/labels'), []);
});

test('a forged gate check opens an audit issue and suspends delegates, once', async () => {
  const client = fakeGitHub({ routes: provenanceRoutes(delegated(), gateCheck(), { ...goodRun, path: '.github/workflows/evil.yml' }) });
  const result = await checkGateProvenance(client, 'o/r', delegated(), 'm1', async () => []);
  assert.equal(result.ok, false);
  const titles = posted(client).filter((b) => b.title).map((b) => b.title);
  assert.deepEqual(titles, ['pipeline/gate on #12 did not come from the gate', 'Delegates suspended: the pipeline/gate check on #12 may be forged']);
  assert.equal((await readSuspension(client, 'o/r', delegated())).suspended, true);

  const again = await checkGateProvenance(client, 'o/r', delegated(), 'm1', async () => []);
  assert.equal(again.alreadyReported, true);
  assert.equal(posted(client).filter((b) => b.title).length, 2);
});

// ---------------------------------------------------------------------------
// Pins: post-merge, audit, and the check run without delegates
// ---------------------------------------------------------------------------

const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '555', GITHUB_EVENT_NAME: 'push' };
const saved = {};
before(() => Object.keys(env).forEach((key) => { saved[key] = process.env[key]; process.env[key] = env[key]; }));
after(() => Object.keys(env).forEach((key) => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }));

test('without delegates, a red main opens the same issue as before and reads nothing new', async () => {
  const client = fakeGitHub();
  await postMerge(client, 'o/r', config, ['--result', 'failure']);
  const [issue] = posted(client).filter((b) => b.title);
  assert.equal(issue.title, 'Main is red at aaaaaaa');
  assert.equal(
    issue.body,
    [
      '@owner `verify` failed on main: https://github.com/o/r/actions/runs/555',
      '',
      'T1 merges are blocked until main is green. Agents: reverting or fixing this comes before anything else. See docs/ROLLBACK.md, and cite this issue in the fix with a line reading `Fixes-main-red: #<this issue>`.',
    ].join('\n'),
  );
  assert.equal(client.calls.some((c) => /commits|contents|actions\/runs/.test(c.path)), false);
});

test('with a delegate, the red-main issue carries the full sha', async () => {
  const head = 'a'.repeat(40);
  const client = fakeGitHub({ routes: { [`GET /repos/o/r/commits/${head}`]: { parents: [] }, [`LIST /repos/o/r/commits/${head}/pulls`]: [] } });
  await postMerge(client, 'o/r', delegated(), ['--result', 'failure']);
  const [issue] = posted(client).filter((b) => b.title);
  assert.match(issue.body, new RegExp(`<!-- pipeline:main-red sha=${'a'.repeat(40)} -->`));
});

test('the audit closes only protection issues, and leaves a forged-gate issue open', async () => {
  const healthy = {
    protected: true,
    protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'pipeline/gate', app_id: 15368 }] } },
  };
  const issues = [
    { number: 3, title: 'Branch protection changed', labels: [{ name: 'pipeline:audit' }], user: BOT_USER },
    { number: 4, title: 'pipeline/gate on #12 did not come from the gate', labels: [{ name: 'pipeline:audit' }], user: BOT_USER },
  ];
  const routes = { 'GET /repos/o/r': { default_branch: 'main' }, 'GET /repos/o/r/branches/main': healthy };
  const client = fakeGitHub({ issues, routes });
  await audit(client, 'o/r', delegated());
  assert.deepEqual(client.calls.filter((c) => c.method === 'PATCH').map((c) => c.path), ['/repos/o/r/issues/3']);
  // Without delegates, as before: every open bot audit issue closes.
  const plain = fakeGitHub({ issues, routes });
  await audit(plain, 'o/r', config);
  assert.deepEqual(plain.calls.filter((c) => c.method === 'PATCH').map((c) => c.path).sort(), ['/repos/o/r/issues/3', '/repos/o/r/issues/4']);
});

test('the check run is stamped with its run only when a delegate is configured', () => {
  const input = { pr: { head: 'h1', url: 'u' }, config };
  const result = { status: 'completed', conclusion: 'success', title: 't', summary: 's' };
  assert.deepEqual(checkRunBody(input, result, '555'), {
    name: 'pipeline/gate',
    head_sha: 'h1',
    status: 'completed',
    details_url: 'u',
    output: { title: 't', summary: 's' },
    conclusion: 'success',
  });
  assert.equal(checkRunBody({ ...input, config: delegated() }, result, '555').external_id, '555');
});
