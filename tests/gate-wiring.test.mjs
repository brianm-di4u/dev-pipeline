// Delegate approvers, PR 3: repository state, touch markers, the approval
// record, and the once-per-window delegate re-arm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoState as repoStateBefore } from './fixtures/before-delegates/repo-state.mjs';
import { BOT_USER, fakeGitHub, posted } from './fixtures/fake-github.mjs';
import { delegateMayRearm } from '../template/.pipeline/lib/breaker.mjs';
import { REARM_OK_MARKER, rearmBy, rearmProblems } from '../template/.pipeline/lib/contract.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { readRepoState, readSuspension, stateIssues } from '../template/.pipeline/lib/state.mjs';
import { approvalNotice, delegateInputs, markTouch, touchOf } from '../template/.pipeline/gate.mjs';
import { checkBreaker, issueEvent } from '../template/.pipeline/monitor.mjs';

const config = { admins: ['owner'], breaker: { window: 20, maxFailures: 3 }, tiers: { t2Paths: [] }, merge: {} };
const delegated = (grant = {}) => ({ ...config, delegates: [{ login: 'gardener', approve: true, rearm: true, ...grant }] });

const at = (h, m = 0) => `2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const say = (body, login = 'owner', time = at(10), extra = {}) => ({
  id: Date.parse(time) / 1000,
  body,
  user: { login, type: 'User' },
  // GitHub's own word that the commenter has access, which a delegate's command needs.
  author_association: 'COLLABORATOR',
  created_at: time,
  updated_at: time,
  ...extra,
});
const botSay = (body, time = at(9)) => ({ id: Date.parse(time) / 1000, body, user: BOT_USER, created_at: time, updated_at: time });
const issue = (number, title, label, extra = {}) => ({
  number,
  title,
  labels: label ? [{ name: label }] : [],
  created_at: at(8),
  ...extra,
});
const breaker = (number, extra) => issue(number, 'Circuit breaker tripped: T1 auto-merge is suspended', 'pipeline:breaker', extra);
const red = (number, extra) => issue(number, 'Main is red at abc1234', 'pipeline:main-red', extra);
const suspend = (number, extra) => issue(number, 'Delegates suspended: 2 delegate-approved merges went bad', 'pipeline:delegate-suspended', extra);

// ---------------------------------------------------------------------------
// With no delegates, state reads exactly as before.
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {},
  { issues: [red(4)] },
  { issues: [red(4)], body: 'Fixes-main-red: #4' },
  { issues: [red(4, { state: 'closed' })] },
  { issues: [breaker(5)] },
  { issues: [breaker(5, { state: 'closed' })] },
  { issues: [breaker(5, { state: 'closed' })], comments: { 5: [say('/rearm')] } },
  { issues: [breaker(5, { state: 'closed' })], comments: { 5: [say('/rearm', 'gardener')] } },
  { issues: [breaker(5, { state: 'closed' }), breaker(9)] },
  { issues: [breaker(5), breaker(9, { state: 'closed' })], comments: { 9: [say('/rearm')] } },
  { issues: [red(4, { labels: [] })], note: 'a stripped label hides it, as before' },
  { issues: [red(4, { user: { login: 'owner', type: 'User' } })], note: 'only bot issues count' },
];

test('without delegates, readRepoState matches the old gate reader in every scenario', async () => {
  for (const scenario of SCENARIOS) {
    const now = await readRepoState(fakeGitHub(scenario), 'o/r', config, scenario.body ?? '');
    const then = await repoStateBefore(fakeGitHub(scenario), 'o/r', config, scenario.body ?? '');
    assert.deepEqual(
      { mainRed: now.mainRed, citesMainRed: now.citesMainRed, breakerTripped: now.breakerTripped },
      then,
      JSON.stringify(scenario),
    );
    assert.deepEqual(Object.keys(now).sort(), ['breakerTripped', 'citesMainRed', 'mainRed', 'redIssue']);
  }
});

test('without delegates, state issues come from the same label query as before', async () => {
  const client = fakeGitHub({ issues: [red(4)] });
  await stateIssues(client, 'o/r', config, 'pipeline:main-red', 'open');
  assert.deepEqual(client.calls.map((c) => c.path), [
    '/repos/o/r/issues?state=open&labels=pipeline%3Amain-red&creator=github-actions%5Bbot%5D&per_page=100',
  ]);
});

// ---------------------------------------------------------------------------
// With a delegate.
// ---------------------------------------------------------------------------

// What GitHub keeps when a label is removed: the bot's original labelled event.
const botLabel = (name) => [{ event: 'labeled', label: { name }, actor: { login: 'github-actions[bot]' }, created_at: at(8) }];

test('a stripped label no longer hides a bot state issue', async () => {
  const client = fakeGitHub({
    issues: [red(4, { labels: [], title: 'Notes' }), breaker(5, { labels: [] })],
    events: { 4: botLabel('pipeline:main-red'), 5: botLabel('pipeline:breaker') },
  });
  const state = await readRepoState(client, 'o/r', delegated());
  assert.equal(state.mainRed, true);
  assert.equal(state.breakerTripped, true);
  // A person's issue with the same title doesn't count.
  const forged = fakeGitHub({ issues: [red(4, { user: { login: 'gardener', type: 'User' } })] });
  assert.equal((await readRepoState(forged, 'o/r', delegated())).mainRed, false);
});

test('suspension windows: open until an admin re-arms a closed suspend issue', async () => {
  const lifted = suspend(3, { state: 'closed', created_at: at(8) });
  const closedNoLift = suspend(6, { state: 'closed', created_at: at(11) });
  const client = fakeGitHub({
    issues: [lifted, closedNoLift],
    comments: { 3: [say('/rearm', 'gardener', at(8, 30)), say('/rearm', 'owner', at(9))], 6: [say('/rearm', 'gardener', at(12))] },
  });
  const result = await readSuspension(client, 'o/r', delegated());
  assert.equal(result.suspended, true, 'closing it without an admin /rearm does not lift it');
  assert.deepEqual(result.suspensions.map(({ from, to }) => ({ from, to })), [
    { from: at(8), to: at(9) },
    { from: at(11), to: null },
  ]);
  const none = await readSuspension(fakeGitHub(), 'o/r', delegated());
  assert.deepEqual(none, { suspended: false, suspensions: [] });
});

test('with a delegate, readRepoState carries suspension and the re-arm offer', async () => {
  const client = fakeGitHub({ issues: [breaker(5)], comments: { 5: [botSay(`x\n\n${REARM_OK_MARKER}`)] } });
  const state = await readRepoState(client, 'o/r', delegated());
  assert.equal(state.breakerTripped, true);
  assert.equal(state.delegateRearmOk, true);
  assert.equal(state.suspended, false);
  assert.deepEqual(state.suspensions, []);
});

const grantOk = botSay(`A delegate may re-arm.\n\n${REARM_OK_MARKER}`, at(9));
const free = { suspended: false, suspensions: [] };

test('a delegate re-arm counts once the bot has offered it', () => {
  const found = rearmBy([grantOk, say('/rearm', 'gardener')], delegated(), free);
  assert.equal(found.role, 'delegate');
});

for (const [name, comments, cfg, ctx, why] of [
  ['without the offer', [say('/rearm', 'gardener')], delegated(), free, /did not offer/],
  ['before the offer', [say('/rearm', 'gardener', at(8)), grantOk], delegated(), free, /before the bot offered/],
  ['with no rearm grant', [grantOk, say('/rearm', 'gardener')], delegated({ rearm: false }), free, /no rearm grant/],
  ['posted during the current suspension', [grantOk, say('/rearm', 'gardener')], delegated(), { suspended: true, suspensions: [{ from: at(9, 30), to: null }] }, /posted while/],
  ['inside a suspension window', [grantOk, say('/rearm', 'gardener')], delegated(), { suspended: false, suspensions: [{ from: at(9, 30), to: at(11) }] }, /posted while/],
  ['with unknown suspension', [grantOk, say('/rearm', 'gardener')], delegated(), {}, /could not be read/],
  ['with an edited offer', [{ ...grantOk, updated_at: at(9, 5) }, say('/rearm', 'gardener')], delegated(), free, /did not offer/],
]) {
  test(`a delegate re-arm is void ${name}`, () => {
    assert.equal(rearmBy(comments, cfg, ctx), null);
    assert.ok(rearmProblems(comments.find((c) => c.user.login === 'gardener'), cfg, comments, ctx).some((r) => why.test(r)));
  });
}

test('a re-arm made before a suspension still counts during it', () => {
  const ctx = { suspended: true, suspensions: [{ from: at(11), to: null }] };
  assert.equal(rearmBy([grantOk, say('/rearm', 'gardener', at(10))], delegated(), ctx).role, 'delegate');
});

test('what a bot issue is comes from its own labelled event, not an edited label or title', async () => {
  // A person can add the breaker label to the bot's digest issue; that doesn't make it a breaker.
  const faked = fakeGitHub({
    issues: [issue(9, 'Weekly digest: x', 'pipeline:breaker')],
    events: { 9: [...botLabel('pipeline:digest'), { event: 'labeled', label: { name: 'pipeline:breaker' }, actor: { login: 'gardener' }, created_at: at(9) }] },
  });
  assert.equal((await readRepoState(faked, 'o/r', delegated())).breakerTripped, false);
  // A closed suspension whose label was stripped and title edited still counts, if it looks like no other kind.
  const hidden = fakeGitHub({
    issues: [suspend(3, { state: 'closed', labels: [], title: 'Old note' })],
    events: { 3: botLabel('pipeline:delegate-suspended') },
  });
  assert.equal((await readSuspension(hidden, 'o/r', delegated())).suspended, true);
});

test('a closed breaker re-armed by a delegate within its grant is no longer tripped', async () => {
  const client = fakeGitHub({
    issues: [breaker(5, { state: 'closed' })],
    comments: { 5: [grantOk, say('/rearm', 'gardener')] },
  });
  assert.equal((await readRepoState(client, 'o/r', delegated())).breakerTripped, false);
  const noOffer = fakeGitHub({ issues: [breaker(5, { state: 'closed' })], comments: { 5: [say('/rearm', 'gardener')] } });
  assert.equal((await readRepoState(noOffer, 'o/r', delegated())).breakerTripped, true);
});

test('the re-arm is offered once per window', () => {
  const result = { window: 7 };
  assert.equal(delegateMayRearm({ result, previousRearm: null, config }), true);
  assert.equal(delegateMayRearm({ result, previousRearm: { role: 'admin' }, config }), true);
  assert.equal(delegateMayRearm({ result, previousRearm: { role: 'delegate' }, config }), false);
  assert.equal(delegateMayRearm({ result: { window: 20 }, previousRearm: { role: 'delegate' }, config }), true);
});

const merged = (number, day = 10) => ({
  number,
  merged_at: `2026-11-${day}T00:00:00Z`,
  merge_commit_sha: `f${number}f`.padEnd(40, '0'),
  state: 'closed',
  body: `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: 'a'.repeat(64), tier: 1, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`,
});
const reverts = (number, target) => ({ ...merged(number, 11), body: `Revert-of: ${`f${target}f`.padEnd(40, '0')}` });
const trippingPulls = [merged(1), merged(2), merged(3), reverts(4, 1), reverts(5, 2), reverts(6, 3)];

test('without delegates, a trip opens the breaker issue and posts nothing else', async () => {
  const client = fakeGitHub({ pulls: trippingPulls });
  const result = await checkBreaker(client, 'o/r', config);
  assert.equal(result.tripped, true);
  assert.equal(posted(client, '/comments').length, 0);
});

test('with a delegate, a trip offers one delegate re-arm, but not after a delegate re-armed the last trip in the window', async () => {
  const first = fakeGitHub({ pulls: trippingPulls });
  await checkBreaker(first, 'o/r', delegated(), free);
  const [offer] = posted(first, '/comments');
  assert.match(offer.body, /A delegate \(gardener\) may re-arm this trip once/);
  assert.match(offer.body, /pipeline:delegate-rearm-ok/);

  const again = fakeGitHub({
    pulls: trippingPulls,
    issues: [breaker(2, { state: 'closed', closed_at: '2026-11-01T00:00:00Z' })],
    comments: { 2: [grantOk, say('/rearm', 'gardener')] },
  });
  await checkBreaker(again, 'o/r', delegated(), free);
  assert.equal(posted(again, '/comments').length, 0, 'the second trip in the window needs an admin');

  const noRearm = fakeGitHub({ pulls: trippingPulls });
  await checkBreaker(noRearm, 'o/r', delegated({ rearm: false }), free);
  assert.equal(posted(noRearm, '/comments').length, 0);
});

const breakerEvent = (comment, labels = ['pipeline:breaker']) => ({
  action: 'created',
  comment,
  issue: { number: 5, title: 'Circuit breaker tripped: T1 auto-merge is suspended', labels: labels.map((name) => ({ name })), user: BOT_USER, body: '' },
});

test('without delegates, an admin /rearm re-arms as before, and anyone else does nothing', async () => {
  const client = fakeGitHub({ issues: [breaker(5)] });
  await issueEvent(client, 'o/r', config, 'issue_comment', breakerEvent(say('/rearm')));
  assert.deepEqual(posted(client, '/comments').map((b) => b.body), ['Re-armed. T1 auto-merge is back on, and the failure count starts over.']);
  assert.ok(client.calls.some((c) => c.method === 'PATCH'));

  const other = fakeGitHub({ issues: [breaker(5)] });
  await issueEvent(other, 'o/r', config, 'issue_comment', breakerEvent(say('/rearm', 'gardener')));
  assert.deepEqual(other.calls, []);
});

test('a delegate /rearm closes the breaker when it counts, and says why when it does not', async () => {
  const rearm = say('/rearm', 'gardener');
  const ok = fakeGitHub({ issues: [breaker(5)], comments: { 5: [grantOk, rearm] } });
  await issueEvent(ok, 'o/r', delegated(), 'issue_comment', breakerEvent(rearm), free);
  assert.match(posted(ok, '/comments')[0].body, /^Re-armed by delegate gardener\./);
  assert.ok(ok.calls.some((c) => c.method === 'PATCH' && c.body.state === 'closed'));

  const refused = fakeGitHub({ issues: [breaker(5)], comments: { 5: [rearm] } });
  await issueEvent(refused, 'o/r', delegated(), 'issue_comment', breakerEvent(rearm), free);
  assert.match(posted(refused, '/comments')[0].body, /^The re-arm by gardener doesn't count: the bot did not offer/);
  assert.equal(refused.calls.some((c) => c.method === 'PATCH'), false);

  const stripped = fakeGitHub({ issues: [breaker(5, { labels: [] })], comments: { 5: [grantOk, rearm] }, events: { 5: botLabel('pipeline:breaker') } });
  await issueEvent(stripped, 'o/r', delegated(), 'issue_comment', breakerEvent(rearm, []), free);
  assert.match(posted(stripped, '/comments')[0].body, /^Re-armed by delegate/, 'found by its title');
});

// ---------------------------------------------------------------------------
// Touch markers and gate inputs.
// ---------------------------------------------------------------------------

const prEvent = (action, sender, changes) => ({ action, sender: { login: sender, type: 'User' }, changes, pull_request: { number: 8 } });

test('only a delegate pushing, or editing a body, is a touch', () => {
  assert.equal(touchOf('pull_request_target', prEvent('synchronize', 'gardener'), config), null, 'no delegates configured');
  assert.deepEqual(touchOf('pull_request_target', prEvent('synchronize', 'Gardener'), delegated()), { kind: 'push', login: 'Gardener' });
  assert.deepEqual(touchOf('pull_request_target', prEvent('edited', 'gardener', { body: { from: 'x' } }), delegated()), { kind: 'body', login: 'gardener' });
  assert.equal(touchOf('pull_request_target', prEvent('edited', 'gardener', { title: { from: 'x' } }), delegated()), null);
  assert.equal(touchOf('pull_request_target', prEvent('synchronize', 'owner'), delegated()), null);
  assert.equal(touchOf('pull_request_target', prEvent('opened', 'gardener'), delegated()), null);
  assert.equal(touchOf('issue_comment', prEvent('synchronize', 'gardener'), delegated()), null);
  const bot = { ...prEvent('synchronize', 'gardener'), sender: { login: 'gardener', type: 'Bot' } };
  assert.equal(touchOf('pull_request_target', bot, delegated()), null);
});

test('a touch is marked with a comment and a label', async () => {
  const client = fakeGitHub();
  await markTouch(client, 'o/r', 8, { kind: 'push', login: 'gardener' });
  const [comment] = posted(client, '/comments');
  assert.match(comment.body, /<!-- pipeline:delegate-touch kind=push login=gardener -->/);
  assert.deepEqual(posted(client, '/labels'), [{ labels: ['pipeline:delegate-touched'] }]);
});

test('gate inputs: commit logins, comment markers, and the bot label event that survives deletion', async () => {
  const client = fakeGitHub({
    commits: { 8: [{ author: { login: 'owner' }, committer: { login: 'web-flow' } }, { author: null, committer: { login: 'gardener' } }] },
    events: {
      8: [
        { event: 'labeled', label: { name: 'pipeline:delegate-touched' }, actor: { login: 'github-actions[bot]' }, created_at: at(9) },
        { event: 'labeled', label: { name: 'pipeline:delegate-touched' }, actor: { login: 'owner' }, created_at: at(9) },
        { event: 'unlabeled', label: { name: 'pipeline:delegate-touched' }, actor: { login: 'gardener' }, created_at: at(10) },
      ],
    },
  });
  const comments = [botSay('<!-- pipeline:delegate-touch kind=body login=gardener -->')];
  const inputs = await delegateInputs(client, 'o/r', 8, comments);
  assert.deepEqual(inputs.commitLogins, ['owner', 'web-flow', 'gardener']);
  assert.deepEqual(inputs.touches.map((t) => t.kind), ['body', 'label']);
});

// ---------------------------------------------------------------------------
// The approval record.
// ---------------------------------------------------------------------------

const hash = 'abcdef012345'.padEnd(64, '0');
const CONTRACT = '## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert it.\n';
const verdict = `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`;
const gateConfig = (extra = {}) => ({
  admins: ['owner'],
  tiers: { t0Paths: [], t0Exclude: [], t2Paths: ['**/auth/**', '.pipeline/**'] },
  merge: { t0: 'auto', t1: 'auto', t2: 'human' },
  ...extra,
});
const input = (cfg, overrides = {}) => ({
  pr: { number: 8, author: 'owner', body: `${CONTRACT}${verdict}`, draft: false, base: 'main' },
  changes: [{ path: 'src/auth/a.js', oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' }],
  hash,
  config: cfg,
  verify: 'success',
  comments: [],
  commitLogins: ['owner'],
  touches: [],
  suspended: false,
  suspensions: [],
  ...overrides,
});

test('an admin approval keeps its alarm, word for word', () => {
  const cfg = gateConfig();
  const data = input(cfg);
  const result = evaluateGate(data);
  assert.equal(
    approvalNotice(say('/approve abcdef012345'), data, result),
    "@owner approval recorded for change `abcdef012345`. If you didn't post it, close this PR and investigate.",
  );
  assert.equal(approvalNotice(say('/approve 111111111111'), data, result), null);
  assert.equal(approvalNotice(say('/approve abcdef012345', 'gardener'), data, result), null, 'no delegates: nothing');
});

test('a delegate approval is recorded quietly, or refused with the reason', () => {
  const cfg = gateConfig({ delegates: [{ login: 'gardener', approve: true }] });
  const comment = say('/approve abcdef012345', 'gardener');
  const ok = input(cfg, { comments: [comment] });
  assert.equal(approvalNotice(comment, ok, evaluateGate(ok)), 'Delegate approval by gardener recorded for `abcdef012345`.');

  const adminOnly = input(cfg, {
    comments: [comment],
    changes: [{ path: '.pipeline/gate.mjs', oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' }],
  });
  const refusal = approvalNotice(comment, adminOnly, evaluateGate(adminOnly));
  assert.match(refusal, /^The approval by gardener doesn't count: it touches an admin-only path: \.pipeline\/gate\.mjs\.$/);
  assert.doesNotMatch(refusal, /@owner/);

  const touched = input(cfg, { comments: [comment], touches: [{ kind: 'label' }] });
  assert.match(approvalNotice(comment, touched, evaluateGate(touched)), /the bot has marked it as touched by a delegate/);
  const pushed = input(cfg, { comments: [comment], touches: [{ kind: 'push' }] });
  assert.match(approvalNotice(comment, pushed, evaluateGate(pushed)), /a delegate pushed to it/);
  assert.equal(evaluateGate(touched).conclusion, 'action_required');

  const stale = say('/approve 111111111111', 'gardener');
  assert.match(approvalNotice(stale, ok, evaluateGate(ok)), /is for different content/);
});
