// Delegate approvers, PR 8: the digest splits approvals and decisions by role and
// measures the delegate. Without a delegate it is exactly the old digest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as before from './fixtures/before-delegates/digest.mjs';
import { BOT_USER, fakeGitHub } from './fixtures/fake-github.mjs';
import { renderClassMarker } from '../template/.pipeline/lib/contract.mjs';
import { READ_FAILED, approvalWaits, buildDigest, mergeApproval, renderDigest, summarize, tallyReactions } from '../template/.pipeline/lib/digest.mjs';

const config = { admins: ['owner'], breaker: { window: 20, maxFailures: 3 } };
const delegated = { ...config, delegates: [{ login: 'gardener', approve: true, decide: ['design'] }] };
const now = new Date('2026-11-15T00:00:00Z');

const hashOf = (n) => String(n).padStart(4, '0').padEnd(64, 'a');
const verdict = (n, extra = {}) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hashOf(n), tier: 2, rounds: 2, open: { blocker: 0, should: 0 }, ...extra })}\n-->`;
const sha = (n) => `f${n}f`.padEnd(40, '0');
const merged = (n, extra = {}) => ({
  number: n,
  merged_at: '2026-11-12T00:00:00Z',
  merge_commit_sha: sha(n),
  state: 'closed',
  head: { sha: `h${n}` },
  body: verdict(n, extra),
});
const say = (body, login, at = '2026-11-11T12:00:00Z', extra = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  body,
  user: { login, type: 'User' },
  // GitHub's own word that the commenter has access, which a delegate's command needs.
  author_association: 'COLLABORATOR',
  created_at: at,
  updated_at: at,
  ...extra,
});
const approve = (n, login, at) => say(`/approve ${hashOf(n).slice(0, 12)}`, login, at);
const botIssues = (client, repo, label, state = 'open') =>
  client.list(`/repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&creator=github-actions%5Bbot%5D&per_page=100`);

const scenario = () => ({
  pulls: [
    merged(1, { worker: { model: 'sonnet' }, findings: [{ disposition: 'fixed' }] }),
    merged(2, { worker: { model: 'opus' } }),
    merged(3),
    { ...merged(4), body: `Revert-of: ${sha(2)}` },
  ],
  comments: {
    1: [approve(1, 'owner'), say('looks good', 'owner')],
    2: [say('<!-- pipeline:rationale {"action":"approve"} -->', 'gardener'), approve(2, 'gardener', '2026-11-11T14:00:00Z')],
    3: [approve(3, 'stranger')],
    10: [{ ...say(renderClassMarker('design'), 'github-actions[bot]', '2026-11-10T00:00:00Z'), user: BOT_USER }, say('/decide A', 'gardener')],
  },
  issues: [
    { number: 10, title: 'Decision: x', labels: [{ name: 'decision-needed' }], state: 'closed', created_at: '2026-11-10T00:00:00Z', closed_at: '2026-11-10T06:00:00Z', user: { login: 'owner', type: 'User' } },
    { number: 11, title: 'Admin needed: y', labels: [{ name: 'admin-needed' }], state: 'closed', created_at: '2026-11-11T00:00:00Z', closed_at: '2026-11-11T04:00:00Z', user: { login: 'gardener', type: 'User' } },
    { number: 12, title: 'Delegates suspended: z', labels: [{ name: 'pipeline:delegate-suspended' }], user: BOT_USER },
  ],
  checkRuns: {
    h1: [{ name: 'pipeline/gate', conclusion: 'action_required', app: { slug: 'github-actions' }, completed_at: '2026-11-11T13:00:00Z' }],
    h2: [{ name: 'pipeline/gate', conclusion: 'action_required', app: { slug: 'github-actions' }, completed_at: '2026-11-11T10:00:00Z' }],
  },
});

test('without delegates, the weekly digest and its reads are exactly as before', async () => {
  const newClient = fakeGitHub(scenario());
  const oldClient = fakeGitHub(scenario());
  const now1 = await buildDigest({ client: newClient, repo: 'o/r', now, config, botIssues });
  const then = await before.buildDigest({ client: oldClient, repo: 'o/r', now, config, botIssues });
  assert.deepEqual(now1, then);
  assert.deepEqual(newClient.calls, oldClient.calls);
  assert.equal(renderDigest(now1, config), before.renderDigest(then, config));
});

test('without delegates, summarize matches the old function', () => {
  const s = scenario();
  const commentsByPr = new Map(Object.entries(s.comments).map(([k, v]) => [Number(k), v]));
  const decisions = [{ open: true, waitHours: null }, { open: false, waitHours: 6 }];
  assert.deepEqual(summarize({ merged: s.pulls, commentsByPr, decisions, config }), before.summarize({ merged: s.pulls, commentsByPr, decisions, config }));
});

test('the approval that let a merge through is the admin\'s when there is one', () => {
  const both = [approve(5, 'gardener'), approve(5, 'owner')];
  assert.equal(mergeApproval(both, delegated, hashOf(5)).role, 'admin');
  assert.equal(mergeApproval([approve(5, 'gardener')], delegated, hashOf(5)).role, 'delegate');
  assert.equal(mergeApproval([approve(5, 'gardener')], config, hashOf(5)), null);
});

test('approval wait runs from the first block; an approval before it counts as 0; a PR never blocked, or not read, is apart', () => {
  const blocks = new Map([[1, '2026-11-11T10:00:00Z'], [2, '2026-11-11T13:00:00Z'], [3, null], [4, READ_FAILED]]);
  assert.deepEqual(
    approvalWaits(
      [
        { pr: 1, at: '2026-11-11T12:30:00Z', role: 'admin' },
        { pr: 2, at: '2026-11-11T12:00:00Z', role: 'delegate' },
        { pr: 3, at: '2026-11-11T12:00:00Z', role: 'admin' },
        { pr: 4, at: '2026-11-11T12:00:00Z', role: 'admin' },
      ],
      blocks,
    ),
    [
      { pr: 1, role: 'admin', hours: 2.5, beforeBlock: false },
      { pr: 2, role: 'delegate', hours: 0, beforeBlock: true },
      { pr: 4, role: 'admin', readFailed: true },
    ],
  );
});

test('only admins\' reactions to delegates\' rationale count', () => {
  const rationale = { id: 7 };
  const reactions = new Map([[7, [
    { content: '+1', user: { login: 'owner' } },
    { content: '-1', user: { login: 'owner' } },
    { content: '+1', user: { login: 'owner' } },
    { content: '+1', user: { login: 'gardener' } },
  ]]]);
  assert.deepEqual(tallyReactions([rationale], reactions, ['owner']), { rationales: 1, up: 2, down: 1, rate: 2 / 3 });
  assert.equal(tallyReactions([], new Map(), ['owner']).rate, null);
});

test('with a delegate, the digest splits by role and measures the delegate', async () => {
  const client = fakeGitHub({
    ...scenario(),
    routes: { 'LIST /repos/o/r/issues/comments': [] },
  });
  const data = await buildDigest({ client, repo: 'o/r', now, config: delegated, botIssues });
  const s = data.summary;
  assert.deepEqual(s.roles.approvals, { admin: 1, delegate: 1 });
  assert.deepEqual(s.roles.decisions, { admin: 0, delegate: 1 });
  assert.equal(s.approvalWait.delegate.median, 4);
  assert.equal(s.approvalWait.beforeFirstBlock, 1, '#1 was approved before its first block');
  assert.deepEqual(s.delegateReverted, [2]);
  assert.deepEqual(s.byWorker.find((w) => w.model === 'opus'), { model: 'opus', merged: 1, rounds: { median: 2, p95: 2 }, reverted: 1 });
  assert.deepEqual(s.byWorker.find((w) => w.model === 'sonnet'), { model: 'sonnet', merged: 1, rounds: { median: 2, p95: 2 }, reverted: 0 });
  assert.deepEqual(s.escalations, { opened: 1, answered: 1, answerHours: 4, open: [] });
  assert.equal(s.agreement.rationales, 1);
  assert.deepEqual(data.state.suspended, [12]);

  const text = renderDigest(data, delegated);
  assert.match(text, /## Needs attention/);
  assert.match(text, /- Delegates suspended: #12/);
  assert.match(text, /## Delegates/);
  assert.match(text, /\| Approvals \| admin 1, delegate 1 \|/);
  assert.match(text, /\| Delegate-approved merges reverted \| #2 \|/);
  assert.match(text, /## By worker model/);
  assert.match(text, /- #2 by gardener \(delegate\) at/);
  assert.match(text, /- #1 by owner at/);
});

test('pipeline metrics can show the delegate measures before any delegate exists, for a baseline', async () => {
  const data = await buildDigest({
    client: fakeGitHub(scenario()),
    repo: 'o/r',
    now,
    config,
    botIssues,
    since: '2026-11-07T00:00:00.000Z',
    extended: true,
  });
  assert.equal(data.since, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(data.summary.roles.approvals, { admin: 1, delegate: 0 });
  assert.match(renderDigest(data, config), /## Delegates/);
});

test('a worker model from a PR body is checked before it reaches the digest, and counted safely', () => {
  const body = (model) =>
    `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hashOf(9), tier: 1, rounds: 1, open: { blocker: 0, should: 0 }, worker: { model } })}\n-->`;
  const merged = ['sonnet', '__proto__', 'constructor', 'x | y', '@owner ping', 'a'.repeat(101)].map((model, i) => ({ number: 20 + i, body: body(model) }));
  const s = summarize({ merged, commentsByPr: new Map(), decisions: [], config: delegated });
  assert.deepEqual(s.byWorker.map((w) => w.model), ['sonnet', '__proto__', 'constructor']);
  assert.equal(s.byWorker.find((w) => w.model === '__proto__').merged, 1);
  const text = renderDigest({ since: '2026-11-01T00:00:00Z', summary: s, decisions: [], state: { breaker: [], mainRed: [], audit: [] }, extended: true });
  assert.doesNotMatch(text, /@owner ping|x \| y/);
});
