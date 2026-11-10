// Delegate approvers, PR 2: the bot records a decision's class, and a delegate's
// /decide counts only within its grant.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as before from './fixtures/before-delegates/contract.mjs';
import {
  decisionProblems,
  findDecision,
  parseDecisionClass,
  recordedClass,
  renderClassMarker,
} from '../template/.pipeline/lib/contract.mjs';
import { issueEvent } from '../template/.pipeline/monitor.mjs';

const admins = ['owner'];
const config = { admins, breaker: { window: 20, maxFailures: 3 } };
const delegated = (grant = {}) => ({ ...config, delegates: [{ login: 'gardener', decide: ['design', 'security', 'determination'], ...grant }] });

const at = (minute) => `2026-11-09T10:${String(minute).padStart(2, '0')}:00Z`;
const user = (body, login = 'owner', minute = 10, extra = {}) => ({
  id: 1000 + minute,
  body,
  user: { login, type: 'User' },
  // GitHub's own word that the commenter has access, which a delegate's command needs.
  author_association: 'COLLABORATOR',
  created_at: at(minute),
  updated_at: at(minute),
  ...extra,
});
const bot = (body, minute = 1, extra = {}) => ({
  id: minute,
  body,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  created_at: at(minute),
  updated_at: at(minute),
  ...extra,
});
const marker = (cls, minute = 1) => bot(`A decision is needed.\n\n${renderClassMarker(cls)}`, minute);
// The issue was labelled decision-needed once, at minute 0, by the admin who opened it.
const labelledAt = (...minutes) =>
  minutes.map((minute) => ({ event: 'labeled', label: { name: 'decision-needed' }, actor: { login: 'owner' }, created_at: at(minute) }));
const free = { suspended: false, suspensions: [], issueAuthor: 'owner', events: labelledAt(0) };

test('the class is read from the issue form and from the skill line', () => {
  assert.equal(parseDecisionClass('### Class\n\ndesign\n\n### Context\n\nx'), 'design');
  assert.equal(parseDecisionClass('### Class\r\n\r\nSecurity\r\n'), 'security');
  assert.equal(parseDecisionClass('**Class:** determination\n\n**Context:** x'), 'determination');
  assert.equal(parseDecisionClass('- **Class:** legal'), 'legal');
});

test('a missing, unknown, or ambiguous class is unclassified', () => {
  assert.equal(parseDecisionClass(''), null);
  assert.equal(parseDecisionClass('**Class:** design, determination, legal, security, or major.'), null);
  assert.equal(parseDecisionClass('**Class:** trivial'), null);
  assert.equal(parseDecisionClass('**Class:** design\n**Class:** major'), null);
  assert.equal(parseDecisionClass('### Class\n\ndesign\n\n**Class:** legal'), null);
  assert.equal(parseDecisionClass('<!-- **Class:** design -->'), null, 'hidden lines do not count');
  // The same class twice is still one class.
  assert.equal(parseDecisionClass('### Class\n\nmajor\n\n**Class:** major'), 'major');
});

test('the earliest bot marker is the record; others are ignored; an edited bot comment voids it', () => {
  assert.equal(recordedClass([]), null);
  assert.equal(recordedClass([marker('design', 2), marker('major', 1)]).class, 'major');
  assert.equal(recordedClass([user(renderClassMarker('design'))]), null, 'a person cannot post the marker');
  assert.equal(recordedClass([marker('design'), bot('later note', 5, { updated_at: at(9) })]).class, null);
  assert.equal(recordedClass([bot(renderClassMarker('everything'))]).class, null);
  assert.equal(recordedClass([marker(null)]).class, null, 'unclassified is recorded as such');
});

test('with no delegates, findDecision matches the old function and ignores markers', () => {
  const cases = [
    [user('/decide A')],
    [user('/decide A', 'gardener')],
    [marker('design'), user('/decide B', 'gardener', 5), user('/decide A')],
    [user('please /decide A')],
    [user('/decide A', 'owner', 10, { updated_at: 'later' })],
  ];
  for (const comments of cases) {
    const now = findDecision(comments, admins);
    const then = before.findDecision(comments, admins);
    assert.deepEqual(now && { option: now.option, comment: now.comment }, then);
    const viaConfig = findDecision(comments, config);
    assert.deepEqual(viaConfig && { option: viaConfig.option, comment: viaConfig.comment }, then);
  }
});

test('a delegate decide counts for a class in its grant, recorded before it, while not suspended', () => {
  const decision = findDecision([marker('design'), user('/decide A', 'gardener')], delegated(), free);
  assert.deepEqual({ option: decision.option, role: decision.role, class: decision.class }, { option: 'A', role: 'delegate', class: 'design' });
});

const VOID = [
  ['a class outside its grant', [marker('legal'), user('/decide A', 'gardener')], free, /may not decide legal/],
  ['a major decision', [marker('major'), user('/decide A', 'gardener')], free, /may not decide major/],
  ['no recorded class', [user('/decide A', 'gardener')], free, /no class on record/],
  ['an unclassified issue', [marker(null), user('/decide A', 'gardener')], free, /no class on record/],
  ['a marker posted after the comment', [marker('design', 20), user('/decide A', 'gardener', 10)], free, /before the bot recorded/],
  ['a suspension', [marker('design'), user('/decide A', 'gardener')], { suspended: true, suspensions: [] }, /suspended/],
  ['a comment inside a suspension window', [marker('design'), user('/decide A', 'gardener')], { suspended: false, suspensions: [{ from: at(5), to: at(15) }] }, /posted while/],
  ['an unknown suspension state', [marker('design'), user('/decide A', 'gardener')], { issueAuthor: 'owner', events: labelledAt(0) }, /could not be read/],
  ['an issue an outsider opened', [marker('design'), user('/decide A', 'gardener')], { ...free, issueAuthor: 'stranger' }, /opened by stranger, not an admin/],
  ['an issue the delegate opened', [marker('design'), user('/decide A', 'gardener')], { ...free, issueAuthor: 'gardener' }, /opened by gardener, not an admin/],
  ['an unknown author', [marker('design'), user('/decide A', 'gardener')], { ...free, issueAuthor: undefined }, /author could not be read/],
  ['no label history', [marker('design'), user('/decide A', 'gardener')], { ...free, events: undefined }, /label history could not be read/],
  ['a marker from a later labelling, after the first was deleted', [marker('design', 5), user('/decide A', 'gardener')], { ...free, events: labelledAt(0, 4) }, /no class on record/],
  ['a tampered marker', [marker('design'), bot('x', 2, { updated_at: at(3) }), user('/decide A', 'gardener')], free, /no class on record/],
];

for (const [name, comments, ctx, why] of VOID) {
  test(`a delegate decide is void with ${name}`, () => {
    assert.equal(findDecision(comments, delegated(), ctx), null);
    const comment = comments.at(-1);
    assert.ok(decisionProblems(comment, delegated(), comments, ctx).some((r) => why.test(r)));
  });
}

test('council planning ignores suspension, and says the gate re-checks', () => {
  const comments = [marker('design'), user('/decide A', 'gardener')];
  assert.equal(findDecision(comments, delegated(), { ignoreSuspension: true, issueAuthor: 'owner', events: labelledAt(0) }).role, 'delegate');
});

test('an admin decide beats an earlier valid delegate decide; among admins the first counts, as before', () => {
  const comments = [marker('design'), user('/decide B', 'gardener', 5), user('/decide A', 'owner', 10), user('/decide C', 'owner', 12)];
  const decision = findDecision(comments, delegated(), free);
  assert.deepEqual([decision.role, decision.option], ['admin', 'A']);
});

test('the class record holds with one labelling, and a relabel with no surviving marker means unclassified', () => {
  assert.equal(recordedClass([marker('design', 1)], labelledAt(0)).class, 'design');
  assert.equal(recordedClass([marker('design', 1)], labelledAt(0, 3)).class, 'design', 'the record answers the first labelling');
  assert.equal(recordedClass([marker('design', 5)], labelledAt(0, 3)).class, null, 'a marker after the second labelling');
  assert.equal(recordedClass([marker('design', 1)], []).class, null, 'no labelling at all');
});

test('an admin decides any class, and a void delegate decide never shadows it', () => {
  const comments = [marker('legal'), user('/decide B', 'gardener', 5), user('/decide A', 'owner', 10)];
  const decision = findDecision(comments, delegated(), free);
  assert.equal(decision.role, 'admin');
  assert.equal(decision.option, 'A');
  assert.equal(decision.class, 'legal');
});

// ---------------------------------------------------------------------------
// monitor.mjs issue-event, with a fake GitHub.
// ---------------------------------------------------------------------------

function fakeClient(comments = [], events = labelledAt(0)) {
  const calls = [];
  return {
    calls,
    list: async (path) => (path.includes('/events') ? events : comments),
    post: async (path, body) => {
      calls.push({ path, body });
      return {};
    },
    patch: async (path, body) => {
      calls.push({ path, body, method: 'PATCH' });
      return {};
    },
  };
}
const labelled = (body, labels = ['decision-needed']) => ({
  action: 'labeled',
  label: { name: 'decision-needed' },
  issue: { number: 7, body, labels: labels.map((name) => ({ name })), user: { login: 'owner' } },
});
const commented = (comment, labels = ['decision-needed']) => ({
  action: 'created',
  comment,
  issue: { number: 7, body: '', labels: labels.map((name) => ({ name })), user: { login: 'owner' } },
});
const comments = (client) => client.calls.filter((c) => c.path.endsWith('/comments')).map((c) => c.body.body);
const labelsAdded = (client) => client.calls.filter((c) => c.path.endsWith('/issues/7/labels')).flatMap((c) => c.body.labels);

test('without delegates, the decision notice is exactly as before', async () => {
  const client = fakeClient();
  await issueEvent(client, 'o/r', config, 'issues', labelled('**Class:** design'));
  assert.deepEqual(comments(client), ['@owner a decision is needed here. Answer with a comment containing only `/decide <option>`.']);
});

test('without delegates, an admin decide is labelled and nothing else happens', async () => {
  const admin = fakeClient();
  await issueEvent(admin, 'o/r', config, 'issue_comment', commented(user('/decide A')));
  assert.deepEqual(labelsAdded(admin), ['decided']);
  assert.deepEqual(comments(admin), []);

  const other = fakeClient();
  await issueEvent(other, 'o/r', config, 'issue_comment', commented(user('/decide A', 'gardener')));
  assert.deepEqual(other.calls, []);
});

test('with a delegate, a delegable class is recorded and the admins are not pinged', async () => {
  const client = fakeClient();
  await issueEvent(client, 'o/r', delegated(), 'issues', labelled('**Class:** design'));
  const [body] = comments(client);
  assert.doesNotMatch(body, /@owner/);
  assert.match(body, /A delegate \(gardener\) or an admin can decide it/);
  assert.match(body, /<!-- pipeline:decision-class design -->/);
});

test('with a delegate, a class outside every grant pings the admins and is still recorded', async () => {
  for (const [body, cls, why] of [
    ['**Class:** legal', 'legal', /only an admin/],
    ['no class here', 'unclassified', /missing or unclear/],
  ]) {
    const client = fakeClient();
    await issueEvent(client, 'o/r', delegated(), 'issues', labelled(body));
    const [text] = comments(client);
    assert.match(text, /^@owner a decision is needed here\./);
    assert.match(text, why);
    assert.match(text, new RegExp(`<!-- pipeline:decision-class ${cls} -->`));
  }
});

test('a relabel never records a second class, so editing the body cannot lower it', async () => {
  const client = fakeClient([marker('legal')]);
  await issueEvent(client, 'o/r', delegated(), 'issues', labelled('**Class:** design'));
  const [text] = comments(client);
  assert.doesNotMatch(text, /pipeline:decision-class/);
  assert.match(text, /This is a legal decision/);
});

test('a delegate decide that counts is labelled and recorded without a ping', async () => {
  const decide = user('/decide A', 'gardener');
  const client = fakeClient([marker('design'), decide]);
  await issueEvent(client, 'o/r', delegated(), 'issue_comment', commented(decide), free);
  assert.deepEqual(labelsAdded(client), ['decided']);
  assert.deepEqual(comments(client), ['Delegate decision by gardener recorded: `A` (design).']);
});

test('a delegate decide that does not count gets the reason and no label', async () => {
  const decide = user('/decide A', 'gardener');
  const client = fakeClient([marker('legal'), decide]);
  await issueEvent(client, 'o/r', delegated(), 'issue_comment', commented(decide), free);
  assert.deepEqual(labelsAdded(client), []);
  assert.match(comments(client)[0], /^The decision by gardener doesn't count: gardener may not decide legal questions\.$/);

  const unknown = fakeClient([marker('design'), decide]);
  await issueEvent(unknown, 'o/r', delegated(), 'issue_comment', commented(decide));
  assert.match(comments(unknown)[0], /suspension state could not be read/);
});
