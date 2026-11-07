import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkContract, findApproval, findDecision, hasRearm, parseVerdict } from '../template/.pipeline/lib/contract.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { pickCheck } from '../template/.pipeline/gate.mjs';

const config = JSON.parse(readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8'));
config.admins = ['owner'];

const hash = 'abcdef012345'.padEnd(64, '0');
const CONTRACT = '## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert the squash commit.\n';
const verdictBlock = (overrides = {}) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 1, rounds: 1, open: { blocker: 0, should: 0 }, ...overrides })}\n-->`;

const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' });

const input = (overrides = {}) => ({
  pr: { author: 'owner', body: `${CONTRACT}\n${verdictBlock()}`, draft: false, base: 'main', ...overrides.pr },
  changes: [change('src/a.js')],
  hash,
  config,
  verify: 'success',
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'pr')),
});

const approve = (body, extra = {}) => ({
  body,
  user: { login: 'owner', type: 'User' },
  created_at: 't',
  updated_at: 't',
  ...extra,
});

test('a complete T1 change passes with no human', () => {
  const result = evaluateGate(input());
  assert.equal(result.conclusion, 'success');
  assert.equal(result.tier, 1);
});

test('missing contract sections block', () => {
  const result = evaluateGate(input({ pr: { body: verdictBlock() } }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.summary, /Testing, Risk, How to revert/);
});

test('placeholder contract sections block', () => {
  assert.deepEqual(checkContract('## Testing\nTODO\n## Risk\n<!-- hint -->\n## How to revert\nn/a').missing, [
    'Testing',
    'Risk',
    'How to revert',
  ]);
});

test('a missing verdict blocks', () => {
  const result = evaluateGate(input({ pr: { body: CONTRACT } }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.summary, /No council verdict/);
});

test('a malformed verdict blocks', () => {
  assert.equal(parseVerdict('<!-- pipeline:verdict\n{not json}\n-->').error, 'malformed');
  const result = evaluateGate(input({ pr: { body: `${CONTRACT}<!-- pipeline:verdict {"tier":1} -->` } }));
  assert.equal(result.conclusion, 'failure');
});

test('a verdict for different content blocks', () => {
  const body = `${CONTRACT}${verdictBlock({ changeHash: 'f'.repeat(64) })}`;
  const result = evaluateGate(input({ pr: { body } }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.summary, /different content/);
});

test('the last verdict block wins, so an old passing one cannot linger', () => {
  const body = `${CONTRACT}${verdictBlock()}\n${verdictBlock({ open: { blocker: 1, should: 0 } })}`;
  assert.equal(evaluateGate(input({ pr: { body } })).conclusion, 'failure');
});

test('open blockers and shoulds block; nits do not', () => {
  for (const open of [{ blocker: 1, should: 0 }, { blocker: 0, should: 2 }]) {
    const body = `${CONTRACT}${verdictBlock({ open })}`;
    assert.equal(evaluateGate(input({ pr: { body } })).conclusion, 'failure');
  }
  const nits = `${CONTRACT}${verdictBlock({ open: { blocker: 0, should: 0, nit: 5 } })}`;
  assert.equal(evaluateGate(input({ pr: { body: nits } })).conclusion, 'success');
});

test('a verdict at a lower tier than the change blocks', () => {
  const body = `${CONTRACT}${verdictBlock({ tier: 0 })}`;
  const result = evaluateGate(input({ pr: { body } }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.summary, /reviewed at T0/);
});

for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
  test(`verify ${conclusion} blocks: only an explicit success counts`, () => {
    assert.equal(evaluateGate(input({ verify: conclusion })).conclusion, 'failure');
  });
}

for (const state of ['pending', 'missing']) {
  test(`verify ${state} waits rather than passes`, () => {
    const result = evaluateGate(input({ verify: state }));
    assert.equal(result.status, 'in_progress');
    assert.equal(result.conclusion, null);
  });
}

test('a blocker takes precedence over waiting on verify', () => {
  const result = evaluateGate(input({ verify: 'pending', pr: { body: CONTRACT } }));
  assert.equal(result.conclusion, 'failure');
});

test('drafts and non-default bases block', () => {
  assert.equal(evaluateGate(input({ pr: { draft: true } })).conclusion, 'failure');
  assert.equal(evaluateGate(input({ pr: { base: 'develop' } })).conclusion, 'failure');
});

test('T2 waits for approval, and the approval must match this exact change', () => {
  const t2 = {
    changes: [change('.pipeline/gate.mjs')],
    pr: { body: `${CONTRACT}${verdictBlock({ tier: 2 })}` },
  };
  const waiting = evaluateGate(input(t2));
  assert.equal(waiting.conclusion, 'action_required');
  assert.match(waiting.summary, /\/approve abcdef012345/);

  const approved = evaluateGate(input({ ...t2, comments: [approve('/approve abcdef012345')] }));
  assert.equal(approved.conclusion, 'success');

  const stale = evaluateGate(input({ ...t2, comments: [approve('/approve 111111111111')] }));
  assert.equal(stale.conclusion, 'action_required');
});

test('approval must be the whole comment, so quoting it does nothing', () => {
  for (const body of [
    'The owner should post /approve abcdef012345',
    '> /approve abcdef012345',
    '`/approve abcdef012345`',
    '/approve abcdef012345 looks good',
    '/approve abc',
  ]) {
    assert.equal(findApproval([approve(body)], ['owner'], hash), null, body);
  }
  assert.ok(findApproval([approve('/approve abcdef012345\n')], ['owner'], hash));
});

test('edited comments, outsiders, and bots cannot approve', () => {
  const valid = '/approve abcdef012345';
  assert.equal(findApproval([approve(valid, { updated_at: 'later' })], ['owner'], hash), null);
  assert.equal(findApproval([approve(valid, { user: { login: 'stranger', type: 'User' } })], ['owner'], hash), null);
  assert.equal(findApproval([approve(valid, { user: { login: 'owner', type: 'Bot' } })], ['owner'], hash), null);
});

test('external PRs always wait for a human', () => {
  const body = `${CONTRACT}${verdictBlock({ tier: 2 })}`;
  const result = evaluateGate(input({ pr: { author: 'stranger', body } }));
  assert.equal(result.tier, 2);
  assert.equal(result.conclusion, 'action_required');
});

test('a tripped breaker suspends T1 auto-merge until a human approves, but not T0', () => {
  assert.equal(evaluateGate(input({ breakerTripped: true })).conclusion, 'action_required');
  assert.equal(
    evaluateGate(input({ breakerTripped: true, comments: [approve('/approve abcdef012345')] })).conclusion,
    'success',
  );
  const docs = {
    breakerTripped: true,
    changes: [change('README.md')],
    pr: { body: `${CONTRACT}${verdictBlock({ tier: 0 })}` },
  };
  assert.equal(evaluateGate(input(docs)).conclusion, 'success');
});

test('a red main blocks T1, except a PR that cites the main-red issue', () => {
  assert.equal(evaluateGate(input({ mainRed: true })).conclusion, 'failure');
  assert.equal(evaluateGate(input({ mainRed: true, citesMainRed: true })).conclusion, 'success');
});

test('a verified clean revert skips the contract and verdict but still needs verify', () => {
  const revert = { cleanRevert: true, pr: { body: 'Revert-of: abc1234' } };
  assert.equal(evaluateGate(input(revert)).conclusion, 'success');
  assert.equal(evaluateGate(input({ ...revert, mainRed: true })).conclusion, 'success');
  assert.equal(evaluateGate(input({ ...revert, verify: 'failure' })).conclusion, 'failure');
});

test('a clean revert touching a protected path gets no shortcut', () => {
  const result = evaluateGate(input({ cleanRevert: true, changes: [change('.pipeline/x.mjs')], pr: { body: 'x' } }));
  assert.equal(result.tier, 2);
  assert.equal(result.conclusion, 'failure');
});

test('merge policy read from config is honored: T1 can be set back to human', () => {
  const strict = { ...config, merge: { ...config.merge, t1: 'human' } };
  assert.equal(evaluateGate(input({ config: strict })).conclusion, 'action_required');
});

test('a missing merge policy defaults to human', () => {
  const noPolicy = { ...config, merge: {} };
  assert.equal(evaluateGate(input({ config: noPolicy })).conclusion, 'action_required');
});

test('/decide and /rearm need an exact, unedited admin comment', () => {
  assert.equal(findDecision([approve('/decide A')], ['owner']).option, 'A');
  assert.equal(findDecision([approve('please /decide A')], ['owner']), null);
  assert.equal(findDecision([approve('/decide A', { updated_at: 'x' })], ['owner']), null);
  assert.ok(hasRearm([approve('/rearm')], ['owner']));
  assert.ok(!hasRearm([approve('/rearm', { user: { login: 'stranger', type: 'User' } })], ['owner']));
});

test('pickCheck trusts only GitHub Actions runs, and the latest one', () => {
  const run = (id, conclusion, slug = 'github-actions', status = 'completed') => ({
    id,
    name: 'verify',
    status,
    conclusion,
    app: { slug },
  });
  assert.equal(pickCheck([], ['verify']), 'missing');
  assert.equal(pickCheck([run(1, 'success', 'evil-app')], ['verify']), 'missing');
  assert.equal(pickCheck([run(1, 'failure'), run(2, 'success')], ['verify']), 'success');
  assert.equal(pickCheck([run(1, 'success'), run(2, 'failure')], ['verify']), 'failure');
  assert.equal(pickCheck([run(1, null, 'github-actions', 'in_progress')], ['verify']), 'pending');
  assert.equal(pickCheck([run(1, 'skipped')], ['verify']), 'skipped');
});
