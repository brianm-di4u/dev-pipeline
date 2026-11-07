import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligible, nextAction, pickNext, recordOutcome } from '../template/.pipeline/lib/queue.mjs';

const config = { admins: ['owner'], autopilot: { maxPrsPerDay: 2, maxConsecutiveFailures: 2 } };
const now = new Date('2026-11-10T12:00:00Z');
const issue = (number, labels = ['ready'], login = 'owner', extra = {}) => ({
  number,
  title: `Task ${number}`,
  state: 'open',
  user: { login },
  labels: labels.map((name) => ({ name })),
  ...extra,
});
const decide = (overrides = {}) =>
  nextAction({ issues: [], config, mainRed: false, breakerTripped: false, merges: [], openOwnPrs: [], run: {}, now, ...overrides });

test('issues from outsiders never start work, even labeled ready', () => {
  assert.equal(eligible(issue(1, ['ready'], 'stranger'), ['owner']), false);
  assert.equal(decide({ issues: [issue(1, ['ready'], 'stranger')] }).action, 'stop');
});

test('triage, blocked, and decision issues are not eligible', () => {
  for (const labels of [['ready', 'triage'], ['ready', 'blocked:decision'], ['ready', 'decision-needed'], []]) {
    assert.equal(eligible(issue(1, labels), ['owner']), false, labels.join());
  }
});

test('PRs that appear in the issues list are not eligible', () => {
  assert.equal(eligible(issue(1, ['ready'], 'owner', { pull_request: {} }), ['owner']), false);
});

test('the queue goes by priority, then oldest first', () => {
  const issues = [issue(5), issue(3), issue(9, ['ready', 'priority:high']), issue(1, ['ready', 'priority:low'])];
  assert.equal(pickNext(issues, ['owner']).number, 9);
  assert.equal(pickNext(issues.slice(0, 2), ['owner']).number, 3);
});

test('a failed read is reported as a failure, not an empty queue', () => {
  const result = decide({ sourceError: 'HTTP 502' });
  assert.equal(result.action, 'stop');
  assert.match(result.reason, /not an empty queue/);
});

test('a red main comes before everything', () => {
  assert.equal(decide({ mainRed: true, issues: [issue(1)] }).action, 'fix-main');
});

test('a tripped breaker stops work', () => {
  const result = decide({ breakerTripped: true, issues: [issue(1)] });
  assert.equal(result.action, 'stop');
  assert.match(result.reason, /circuit breaker/);
});

test('repeated failures stop work', () => {
  assert.equal(decide({ issues: [issue(1)], run: { consecutiveFailures: 2 } }).action, 'stop');
  assert.equal(decide({ issues: [issue(1)], run: { consecutiveFailures: 1 } }).action, 'work');
});

test('one PR at a time', () => {
  const result = decide({ issues: [issue(1)], openOwnPrs: [7] });
  assert.equal(result.action, 'finish-pr');
  assert.equal(result.pr, 7);
});

test('the daily budget comes from GitHub state, so a restart cannot reset it', () => {
  const recent = (hoursAgo) => ({ merged_at: new Date(now.getTime() - hoursAgo * 3600000).toISOString() });
  assert.equal(decide({ issues: [issue(1)], merges: [recent(1)] }).action, 'work');
  const spent = decide({ issues: [issue(1)], merges: [recent(1), recent(2)] });
  assert.equal(spent.action, 'stop');
  assert.match(spent.reason, /budget/);
  assert.equal(decide({ issues: [issue(1)], merges: [recent(30), recent(40)] }).action, 'work');
});

test('an empty queue stops cleanly', () => {
  assert.match(decide().reason, /empty/);
});

test('a merge clears the failure count; waiting on a decision leaves it alone', () => {
  let run = { consecutiveFailures: 0 };
  run = recordOutcome(run, { state: 'failed' });
  run = recordOutcome(run, { state: 'failed' });
  assert.equal(run.consecutiveFailures, 2);
  run = recordOutcome(run, { state: 'decision' });
  assert.equal(run.consecutiveFailures, 2);
  run = recordOutcome(run, { state: 'merged' });
  assert.equal(run.consecutiveFailures, 0);
  assert.equal(run.history.length, 4);
});
