// Delegate approvers (PR 1 of the gardener work): config, the admin-only floor,
// and role-aware approval. The first half pins today's behaviour when no
// `delegates` key is set, against a frozen copy of the code from before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as before from './fixtures/before-delegates/contract.mjs';
import { evaluateGate as evaluateBefore } from './fixtures/before-delegates/gate-core.mjs';
import { classify as classifyBefore } from './fixtures/before-delegates/tier.mjs';
import { ADMIN_ONLY_FLOOR, authority, cleanDelegates, toAuthority } from '../template/.pipeline/lib/authority.mjs';
import { parseConfig } from '../template/.pipeline/lib/config.mjs';
import {
  actorOf,
  delegateBarriers,
  delegateRefusals,
  findApproval,
  findDecision,
  hasRearm,
  inWindow,
  touchMarkers,
} from '../template/.pipeline/lib/contract.mjs';
import { summarize } from '../template/.pipeline/lib/digest.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { classify } from '../template/.pipeline/lib/tier.mjs';

const templateText = readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8');
const base = JSON.parse(templateText);
base.admins = ['owner'];

const hash = 'abcdef012345'.padEnd(64, '0');
const short = hash.slice(0, 12);
const CONTRACT = '## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert the squash commit.\n';
const verdictBlock = (overrides = {}) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 }, ...overrides })}\n-->`;
const change = (path, newMode = '100644') => ({ path, oldMode: '100644', newMode, oldSha: 'a', newSha: 'b', status: 'M' });
const comment = (body, login = 'owner', extra = {}) => ({
  body,
  user: { login, type: 'User' },
  created_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T10:00:00Z',
  ...extra,
});
const botComment = (body, at = '2026-11-09T09:00:00Z') => ({
  body,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  created_at: at,
  updated_at: at,
});

// ---------------------------------------------------------------------------
// With no `delegates` key, behaviour is exactly today's.
// ---------------------------------------------------------------------------

test('parseConfig with no delegates key returns the config untouched and warns about nothing', () => {
  const warnings = [];
  const parsed = parseConfig(templateText, { warn: (m) => warnings.push(m) });
  assert.deepEqual(parsed, JSON.parse(templateText));
  assert.equal('delegates' in parsed, false);
  assert.deepEqual(warnings, []);
});

test('authority with no delegates key has no delegates and no admin-only paths', () => {
  const auth = authority(base);
  assert.deepEqual(auth.delegates, []);
  assert.deepEqual(auth.adminOnlyPaths, []);
  assert.equal(auth.isAdmin('owner'), true);
  assert.equal(auth.delegateOf('owner'), null);
  // Config admin-only paths mean nothing without a delegate.
  assert.deepEqual(authority({ ...base, tiers: { ...base.tiers, adminOnlyPaths: ['docs/POLICY.md'] } }).adminOnlyPaths, []);
});

const PATH_SETS = [
  ['src/a.js'],
  ['README.md', 'docs/guide.md'],
  ['docs/decisions/0002-x.md'],
  ['.pipeline/gate.mjs'],
  ['.claude/skills/gardener/SKILL.md'],
  ['.claude/skills/x/SKILL.md'],
  ['docs/POLICY.md'],
  ['pipeline.config.json'],
  ['.github/workflows/gate.yml'],
  ['.github/workflows/ci.yml'],
  ['package.json'],
  [change('docs/guide.md', '120000')],
  [change('vendor/lib', '160000')],
];
const AUTHORS = ['owner', 'stranger', 'dependabot[bot]', 'gardener'];
const EXTRAS = [
  {},
  { scriptsChangedIn: ['package.json'] },
  { aiRaise: { reason: 'design call' } },
  { adrCited: true },
  { cleanRevert: true },
];
const toChanges = (paths) => paths.map((p) => (typeof p === 'string' ? change(p) : p));

test('classify gives the same tier and reasons as before for every case, and only adds flags', () => {
  for (const paths of PATH_SETS) {
    for (const author of AUTHORS) {
      for (const extra of EXTRAS) {
        const args = { changes: toChanges(paths), config: base, author, ...extra };
        const now = classify(args);
        const then = classifyBefore(args);
        assert.deepEqual({ tier: now.tier, reasons: now.reasons }, then, JSON.stringify({ paths, author, extra }));
        assert.ok(now.flags && typeof now.flags.external === 'boolean');
      }
    }
  }
});

const COMMENT_SETS = [
  [],
  [comment(`/approve ${short}`)],
  [comment(`/approve ${short}`, 'gardener')],
  [comment(`/approve ${short}`, 'stranger')],
  [comment(`/approve ${short}`, 'owner', { updated_at: 'later' })],
  [comment(`/approve ${short}`, 'owner', { user: { login: 'owner', type: 'Bot' } })],
  [comment('/approve 111111111111')],
  [comment(`please /approve ${short}`), comment(`/approve ${short}`)],
  [botComment('<!-- pipeline:delegate-touch kind=push login=gardener -->'), comment(`/approve ${short}`)],
];
const GATE_CASES = [
  {},
  { changes: [change('.pipeline/gate.mjs')] },
  { changes: [change('.claude/skills/gardener/SKILL.md')], pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
  { changes: [change('docs/POLICY.md')], pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
  { changes: [change('README.md')], pr: { body: `${CONTRACT}${verdictBlock({ tier: 0 })}` } },
  { pr: { author: 'stranger' } },
  { pr: { draft: true } },
  { pr: { body: CONTRACT } },
  { verify: 'pending' },
  { verify: 'failure' },
  { breakerTripped: true, pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
  { mainRed: true },
  { mainRed: true, citesMainRed: true },
  { cleanRevert: true, pr: { body: 'Revert-of: abc1234' } },
  { config: { ...base, merge: { ...base.merge, t1: 'human' } }, pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
  { scriptsChangedIn: ['package.json'], changes: [change('package.json')] },
  { changes: [change('docs/guide.md', '120000')] },
  { commitLogins: ['gardener'], suspended: false, suspensions: [] },
];
const gateInput = (overrides, comments) => ({
  changes: [change('src/a.js')],
  hash,
  config: base,
  verify: 'success',
  comments,
  ...overrides,
  pr: { author: 'owner', body: `${CONTRACT}\n${verdictBlock()}`, draft: false, base: 'main', ...overrides.pr },
});

test('evaluateGate returns exactly what it did before, for every case', () => {
  for (const overrides of GATE_CASES) {
    for (const comments of COMMENT_SETS) {
      const input = gateInput(overrides, comments);
      assert.deepEqual(evaluateGate(input), evaluateBefore(input), JSON.stringify({ overrides, comments }));
    }
  }
});

test('findApproval, findDecision and hasRearm with a bare admins list match the old functions', () => {
  const bodies = [`/approve ${short}`, '/approve 111111111111', '/decide A', 'please /decide A', '/rearm', ' /rearm\n', 'x'];
  const users = [
    { login: 'owner', type: 'User' },
    { login: 'owner', type: 'Bot' },
    { login: 'stranger', type: 'User' },
    { login: 'gardener', type: 'User' },
  ];
  for (const body of bodies) {
    for (const user of users) {
      for (const updated of ['2026-11-09T10:00:00Z', 'later']) {
        const list = [comment(body, user.login, { user, updated_at: updated })];
        assert.equal(findApproval(list, ['owner'], hash)?.comment ?? null, before.findApproval(list, ['owner'], hash));
        assert.deepEqual(findDecision(list, ['owner']), before.findDecision(list, ['owner']));
        assert.equal(hasRearm(list, ['owner']), before.hasRearm(list, ['owner']));
        // A config with no delegates behaves like the bare list.
        assert.equal(findApproval(list, base, hash)?.comment ?? null, before.findApproval(list, ['owner'], hash));
      }
    }
  }
});

test('an admin approval reports its role', () => {
  const approval = findApproval([comment(`/approve ${short}`)], ['owner'], hash);
  assert.equal(approval.role, 'admin');
  assert.equal(approval.comment.user.login, 'owner');
});

test('the digest still records admin approvals as before', () => {
  const merged = [{ number: 3, body: verdictBlock() }];
  const commentsByPr = new Map([[3, [comment(`/approve ${short}`)]]]);
  const summary = summarize({ merged, commentsByPr, decisions: [], config: base });
  assert.deepEqual(summary.approvals, [{ pr: 3, by: 'owner', at: '2026-11-09T10:00:00Z' }]);
});

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

const withDelegates = (delegates, tiers = {}) =>
  JSON.stringify({ ...base, delegates, tiers: { ...base.tiers, ...tiers } });
const parseQuietly = (text) => {
  const warnings = [];
  const config = parseConfig(text, { warn: (m) => warnings.push(m) });
  return { config, warnings };
};

test('a valid delegate is kept, with every grant spelled out', () => {
  const { config, warnings } = parseQuietly(withDelegates([{ login: 'gardener', approve: true, decide: ['design'] }]));
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.delegates, [
    { login: 'gardener', approve: true, approveExternal: false, decide: ['design'], rearm: false, direct: false },
  ]);
});

test('a malformed delegate entry is dropped with a warning, never thrown', () => {
  for (const entry of [
    null,
    'gardener',
    { approve: true },
    { login: '' },
    { login: 'has space' },
    { login: 'gardener[bot]' },
    { login: 'gardener', approve: 'yes' },
    { login: 'gardener', rearm: 1 },
    { login: 'gardener', decide: 'design' },
    { login: 'gardener', decide: ['design', 'everything'] },
  ]) {
    const { config, warnings } = parseQuietly(withDelegates([entry, { login: 'ok-one', approve: true }]));
    assert.deepEqual(config.delegates.map((d) => d.login), ['ok-one'], JSON.stringify(entry));
    assert.equal(warnings.length, 1, JSON.stringify(entry));
  }
});

test('a delegate that is also an admin is dropped, whatever the case', () => {
  const { config, warnings } = parseQuietly(withDelegates([{ login: 'OWNER', approve: true }]));
  assert.deepEqual(config.delegates, []);
  assert.match(warnings[0], /also an admin/);
});

test('a duplicate delegate keeps only the first entry', () => {
  const { config } = parseQuietly(withDelegates([{ login: 'gardener', approve: true }, { login: 'Gardener', rearm: true }]));
  assert.deepEqual(config.delegates.map((d) => [d.login, d.approve, d.rearm]), [['gardener', true, false]]);
});

test('delegates that are not a list, or a malformed adminOnlyPaths, leave no delegate authority', () => {
  assert.deepEqual(parseQuietly(withDelegates({ login: 'gardener' })).config.delegates, []);
  const bad = parseQuietly(withDelegates([{ login: 'gardener', approve: true }], { adminOnlyPaths: 'docs/POLICY.md' }));
  assert.deepEqual(bad.config.delegates, []);
  assert.match(bad.warnings[0], /adminOnlyPaths/);
});

test('authority re-cleans a config it is handed directly', () => {
  const auth = authority({ admins: ['owner'], delegates: [{ login: 'owner', approve: true }, { login: 'gardener', approve: 1 }] });
  assert.deepEqual(auth.delegates, []);
  assert.equal(cleanDelegates({ admins: ['owner'] }), undefined);
  assert.equal(toAuthority(['owner']).isAdmin('owner'), true);
});

// ---------------------------------------------------------------------------
// The admin-only floor.
// ---------------------------------------------------------------------------

const delegateConfig = (grant = {}, tiers = {}) => ({
  ...base,
  delegates: [{ login: 'gardener', approve: true, ...grant }],
  tiers: { ...base.tiers, ...tiers },
});

test('with a delegate, the floor is admin-only, and config adds to it but never subtracts', () => {
  const auth = authority(delegateConfig({}, { adminOnlyPaths: ['docs/POLICY.md'] }));
  for (const path of ADMIN_ONLY_FLOOR) assert.ok(auth.adminOnlyPaths.includes(path), path);
  assert.ok(auth.adminOnlyPaths.includes('docs/POLICY.md'));
  // A config can't remove the floor by listing fewer paths.
  assert.deepEqual(authority(delegateConfig({}, { adminOnlyPaths: [] })).adminOnlyPaths, ADMIN_ONLY_FLOOR);
});

test('admin-only paths force T2, so they cannot auto-merge at T1', () => {
  const config = delegateConfig({}, { adminOnlyPaths: ['docs/POLICY.md', 'TRADEMARKS.md'] });
  for (const path of ['.claude/skills/gardener/SKILL.md', 'docs/POLICY.md', 'TRADEMARKS.md', '.Claude/Skills/Gardener./x.md']) {
    const result = classify({ changes: [change(path)], config, author: 'owner' });
    assert.equal(result.tier, 2, path);
    assert.ok(result.reasons.some((r) => r.startsWith('Admin-only path:')), path);
    assert.equal(result.flags.adminOnly.length, 1, path);
  }
  for (const path of ['.github/workflows/gate.yml', '.github/workflows/decisions.yml', '.github/workflows/post-merge.yml', '.github/workflows/audit.yml', '.github/workflows/release.yml']) {
    assert.deepEqual(classify({ changes: [change(path)], config, author: 'owner' }).flags.adminOnly, [path]);
  }
  // Other workflows stay ordinary T2, which a delegate may approve.
  assert.deepEqual(classify({ changes: [change('.github/workflows/ci.yml')], config, author: 'owner' }).flags.adminOnly, []);
});

test('classify reports symlinks, scripts, outside authors and a council raise as flags', () => {
  const config = delegateConfig();
  const flags = classify({
    changes: [change('src/a.js'), change('docs/link.md', '120000')],
    config,
    author: 'stranger',
    scriptsChangedIn: ['package.json'],
    aiRaise: { reason: 'x' },
  }).flags;
  assert.deepEqual(flags, {
    external: true,
    adminOnly: [],
    scripts: ['package.json'],
    symlinks: ['docs/link.md'],
    raised: true,
  });
});

// ---------------------------------------------------------------------------
// Commands by role.
// ---------------------------------------------------------------------------

test('actorOf: admin, delegate, or nobody', () => {
  const auth = authority(delegateConfig());
  assert.equal(actorOf(comment('/x'), auth), 'admin');
  assert.equal(actorOf(comment('/x', 'gardener'), auth), 'delegate');
  assert.equal(actorOf(comment('/x', 'Gardener'), auth), 'delegate');
  assert.equal(actorOf(comment('/x', 'stranger'), auth), null);
  assert.equal(actorOf(comment('/x', 'gardener', { updated_at: 'later' }), auth), null);
  assert.equal(actorOf(comment('/x', 'gardener', { user: { login: 'gardener', type: 'Bot' } }), auth), null);
  // A bare admins list knows no delegates.
  assert.equal(actorOf(comment('/x', 'gardener'), ['owner']), null);
});

const flagsFor = (paths, author = 'owner', extra = {}) =>
  classify({ changes: toChanges(paths), config: delegateConfig(extra.grant), author, ...extra.classify }).flags;
const goodCtx = (overrides = {}) => ({
  flags: flagsFor(['src/a.js']),
  author: 'owner',
  commitLogins: ['owner'],
  touches: [],
  suspended: false,
  suspensions: [],
  ...overrides,
});
const delegateApproval = (extra) => comment(`/approve ${short}`, 'gardener', extra);

test('a delegate approval counts when every condition holds', () => {
  const approval = findApproval([delegateApproval()], delegateConfig(), hash, goodCtx());
  assert.equal(approval.role, 'delegate');
  assert.deepEqual(delegateBarriers(delegateConfig(), 'gardener', goodCtx()), []);
});

const VOID_CASES = [
  ['no approve grant', { config: delegateConfig({ approve: false }) }, /no approve grant/],
  ['an admin-only path', { ctx: { flags: flagsFor(['.pipeline/gate.mjs']) } }, /admin-only path/],
  ['a symlink', { ctx: { flags: flagsFor([change('docs/x.md', '120000')]) } }, /symlink/],
  ['changed scripts', { ctx: { flags: flagsFor(['package.json'], 'owner', { classify: { scriptsChangedIn: ['package.json'] } }) } }, /scripts/],
  ['an outside author', { ctx: { author: 'stranger', flags: flagsFor(['src/a.js'], 'stranger') } }, /outside author/],
  ['the delegate opened the PR', { ctx: { author: 'gardener', flags: flagsFor(['src/a.js'], 'gardener') } }, /opened this PR/],
  ['the delegate is on a commit', { ctx: { commitLogins: ['owner', 'Gardener'] } }, /authored or committed/],
  ['a push touch marker', { ctx: { touches: [{ kind: 'push', login: 'gardener' }] } }, /pushed to it/],
  ['a body touch marker', { ctx: { touches: [{ kind: 'body', login: 'gardener' }] } }, /edited its body/],
  ['a suspension', { ctx: { suspended: true } }, /suspended/],
  ['posted inside a suspension window', { ctx: { suspensions: [{ from: '2026-11-09T09:00:00Z', to: '2026-11-09T11:00:00Z' }] } }, /posted while/],
  ['unknown commit authors', { ctx: { commitLogins: undefined } }, /commit authors/],
  ['unknown suspension state', { ctx: { suspended: undefined } }, /suspension state/],
  ['no classification', { ctx: { flags: undefined } }, /classify/],
];

for (const [name, { config = delegateConfig(), ctx = {} }, why] of VOID_CASES) {
  test(`a delegate approval is void with ${name}`, () => {
    const context = goodCtx(ctx);
    assert.equal(findApproval([delegateApproval()], config, hash, context), null);
    const refusals = delegateRefusals([delegateApproval()], config, hash, context);
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0].reasons.some((r) => why.test(r)), refusals[0].reasons.join('; '));
  });
}

test('an outside author can be approved when the grant opts in, and a council raise stays approvable', () => {
  const config = delegateConfig({ approveExternal: true });
  const ctx = goodCtx({ author: 'stranger', flags: flagsFor(['src/a.js'], 'stranger', { grant: { approveExternal: true } }) });
  assert.equal(findApproval([delegateApproval()], config, hash, ctx).role, 'delegate');
  const raised = goodCtx({ flags: flagsFor(['src/a.js'], 'owner', { classify: { aiRaise: { reason: 'x' } } }) });
  assert.equal(findApproval([delegateApproval()], delegateConfig(), hash, raised).role, 'delegate');
});

test('an approval after a suspension window has closed counts', () => {
  const ctx = goodCtx({ suspensions: [{ from: '2026-11-08T00:00:00Z', to: '2026-11-09T09:00:00Z' }] });
  assert.equal(findApproval([delegateApproval()], delegateConfig(), hash, ctx).role, 'delegate');
  assert.equal(inWindow('2026-11-09T09:00:00Z', [{ from: '2026-11-08T00:00:00Z', to: null }]), true);
  assert.equal(inWindow('2026-11-07T09:00:00Z', [{ from: '2026-11-08T00:00:00Z', to: null }]), false);
});

test('a void delegate approval never shadows a later admin or delegate approval', () => {
  const config = delegateConfig();
  const voidCtx = goodCtx({ commitLogins: ['gardener'] });
  const admin = findApproval([delegateApproval(), comment(`/approve ${short}`)], config, hash, voidCtx);
  assert.equal(admin.role, 'admin');

  const windowCtx = goodCtx({ suspensions: [{ from: '2026-11-09T09:00:00Z', to: '2026-11-09T11:00:00Z' }] });
  const later = delegateApproval({ created_at: '2026-11-09T12:00:00Z', updated_at: '2026-11-09T12:00:00Z' });
  const found = findApproval([delegateApproval(), later], config, hash, windowCtx);
  assert.equal(found.comment, later);
});

test('only the bot can mark a delegate touch', () => {
  const marker = '<!-- pipeline:delegate-touch kind=push login=gardener -->';
  assert.deepEqual(touchMarkers([botComment(marker)]), [{ kind: 'push', login: 'gardener', at: '2026-11-09T09:00:00Z' }]);
  assert.deepEqual(touchMarkers([comment(marker, 'owner')]), []);
  assert.deepEqual(touchMarkers([comment(marker, 'github-actions[bot]')]), [], 'a User account named like the bot');
  // findApproval reads markers from the comments it's given when ctx has none.
  const ctx = goodCtx();
  delete ctx.touches;
  assert.equal(findApproval([botComment(marker), delegateApproval()], delegateConfig(), hash, ctx), null);
});

test('a delegate cannot decide or re-arm through the admin functions', () => {
  const config = delegateConfig({ decide: ['design'], rearm: true });
  assert.equal(findDecision([comment('/decide A', 'gardener')], config), null);
  assert.equal(hasRearm([comment('/rearm', 'gardener')], config), false);
});

// ---------------------------------------------------------------------------
// The gate with a delegate.
// ---------------------------------------------------------------------------

const t2 = (overrides = {}, comments = []) =>
  gateInput(
    {
      config: delegateConfig(),
      changes: [change('src/auth/login.js')],
      commitLogins: ['owner'],
      suspended: false,
      suspensions: [],
      ...overrides,
    },
    comments,
  );

test('a delegate approval turns a T2 change green, and the summary names the delegate', () => {
  const waiting = evaluateGate(t2());
  assert.equal(waiting.conclusion, 'action_required');
  assert.match(waiting.summary, /A delegate may approve this change\./);
  assert.equal(waiting.delegate.mayApprove, true);

  const approved = evaluateGate(t2({}, [delegateApproval()]));
  assert.equal(approved.conclusion, 'success');
  assert.equal(approved.delegate.approvalRole, 'delegate');
  assert.match(approved.summary, /Approved by gardener, a delegate\./);
});

test('an admin-only path stays action_required after a delegate approval, and says why', () => {
  const result = evaluateGate(t2({ changes: [change('.pipeline/gate.mjs')] }, [delegateApproval()]));
  assert.equal(result.conclusion, 'action_required');
  assert.equal(result.delegate.mayApprove, false);
  assert.match(result.summary, /Only an admin can approve this change: it touches an admin-only path: \.pipeline\/gate\.mjs/);
  assert.match(result.summary, /The approval by gardener doesn't count/);

  const admin = evaluateGate(t2({ changes: [change('.pipeline/gate.mjs')] }, [delegateApproval(), comment(`/approve ${short}`)]));
  assert.equal(admin.conclusion, 'success');
  assert.match(admin.summary, /Approved by owner\./);
});

test('without the commit and suspension inputs, a delegate approval fails closed', () => {
  const result = evaluateGate(t2({ commitLogins: undefined, suspended: undefined, suspensions: undefined }, [delegateApproval()]));
  assert.equal(result.conclusion, 'action_required');
  assert.match(result.summary, /could not read/);
});

test('a delegate approval does not lift other blockers', () => {
  const result = evaluateGate(t2({ verify: 'failure' }, [delegateApproval()]));
  assert.equal(result.conclusion, 'failure');
  const red = evaluateGate(t2({ mainRed: true }, [delegateApproval()]));
  assert.equal(red.conclusion, 'failure');
});
