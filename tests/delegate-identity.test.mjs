// A delegate counts only when GitHub itself says, on the comment or issue, that the
// author has access to the repo, and, with an `id` in its grant, only as that
// exact account. Admins, and everything without `delegates`, are unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { grantCovers } from '../template/.claude/hooks/guard.mjs';
import { buildInbox } from '../template/.pipeline/garden.mjs';
import { touchOf } from '../template/.pipeline/gate.mjs';
import { authority, cleanDelegates } from '../template/.pipeline/lib/authority.mjs';
import { decisionProblems, delegateRefusals, findApproval, findDecision, identityProblems, rearmBy, renderClassMarker } from '../template/.pipeline/lib/contract.mjs';
import { eligible } from '../template/.pipeline/lib/queue.mjs';

const at = (h, m = 0) => `2026-11-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const config = (grant = {}) => ({ admins: ['owner'], tiers: {}, delegates: [{ login: 'gardener', approve: true, decide: ['design'], rearm: true, direct: true, ...grant }] });
const say = (body, login = 'gardener', extra = {}) => ({ body, user: { login, id: 42, type: 'User' }, author_association: 'COLLABORATOR', created_at: at(10), updated_at: at(10), ...extra });
const bot = (body, time = at(8)) => ({ body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: time, updated_at: time });
const hash = 'abcdef012345'.padEnd(64, '0');
const ctx = { flags: { adminOnly: [], symlinks: [], scripts: [], external: false, workflows: [] }, author: 'owner', commitLogins: ['owner'], touches: [], suspended: false, suspensions: [] };
const approve = (extra) => say('/approve abcdef012345', 'gardener', extra);

test("a delegate's command counts only with GitHub's access on it", () => {
  const cfg = authority(config());
  for (const association of ['COLLABORATOR', 'MEMBER', 'OWNER']) {
    assert.equal(findApproval([approve({ author_association: association })], cfg, hash, ctx)?.role, 'delegate', association);
  }
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
    const comment = approve({ author_association: association });
    assert.equal(findApproval([comment], cfg, hash, ctx), null, String(association));
    const [refusal] = delegateRefusals([comment], cfg, hash, ctx);
    assert.match(refusal.reasons.join('; '), /GitHub doesn't show gardener with access to this repository/, String(association));
  }
});

test('with an id in the grant, only that account counts', () => {
  const cfg = authority(config({ id: 42 }));
  assert.equal(findApproval([approve()], cfg, hash, ctx)?.role, 'delegate');
  for (const user of [{ login: 'gardener', id: 7, type: 'User' }, { login: 'gardener', type: 'User' }]) {
    const comment = approve({ user });
    assert.equal(findApproval([comment], cfg, hash, ctx), null);
    assert.match(delegateRefusals([comment], cfg, hash, ctx)[0].reasons.join('; '), /not gardener's configured id 42/);
  }
  // Without an id, any id passes, as long as GitHub shows the access.
  assert.equal(findApproval([approve({ user: { login: 'gardener', id: 7, type: 'User' } })], authority(config()), hash, ctx)?.role, 'delegate');
});

test('an admin is unchanged: no association or id is asked of one', () => {
  const cfg = authority(config({ id: 42 }));
  const bare = { body: '/approve abcdef012345', user: { login: 'owner', type: 'User' }, created_at: at(10), updated_at: at(10) };
  assert.equal(findApproval([bare], cfg, hash, ctx)?.role, 'admin');
  assert.equal(findDecision([{ ...bare, body: '/decide A' }], cfg, { events: [] })?.role, 'admin');
  assert.equal(rearmBy([{ ...bare, body: '/rearm' }], cfg, { suspensions: [] })?.role, 'admin');
});

test("a delegate's decide and re-arm need the same", () => {
  const cfg = authority(config({ id: 42 }));
  const marker = bot(renderClassMarker('design'), at(8, 1));
  const events = [{ event: 'labeled', label: { name: 'decision-needed' }, actor: { login: 'owner' }, created_at: at(8) }];
  const issueCtx = { issueAuthor: 'owner', events, suspended: false, suspensions: [] };
  const decide = say('/decide A');
  assert.deepEqual(decisionProblems(decide, cfg, [marker, decide], issueCtx), []);
  const strayDecide = say('/decide A', 'gardener', { author_association: 'NONE' });
  assert.match(decisionProblems(strayDecide, cfg, [marker, strayDecide], issueCtx).join('; '), /with access/);
  const offer = bot('<!-- pipeline:delegate-rearm-ok -->');
  assert.equal(rearmBy([offer, say('/rearm')], cfg, { suspensions: [] })?.role, 'delegate');
  assert.equal(rearmBy([offer, say('/rearm', 'gardener', { user: { login: 'gardener', id: 9, type: 'User' } })], cfg, { suspensions: [] }), null);
});

test("a delegate's direct issue starts work only with GitHub's access on it", () => {
  const issue = (extra = {}) => ({ number: 1, state: 'open', labels: [{ name: 'ready' }], user: { login: 'gardener', id: 42 }, author_association: 'COLLABORATOR', ...extra });
  assert.equal(eligible(issue(), config()), true);
  assert.equal(eligible(issue({ author_association: 'NONE' }), config()), false);
  assert.equal(eligible(issue({ author_association: undefined }), config()), false);
  assert.equal(eligible(issue(), config({ id: 42 })), true);
  assert.equal(eligible(issue({ user: { login: 'gardener', id: 7 } }), config({ id: 42 })), false);
  // An admin's issue, as before.
  assert.equal(eligible(issue({ user: { login: 'owner' }, author_association: undefined }), config()), true);
});

test('a push or an edit by the delegate account is caught by login, or by id when the login changed', () => {
  const event = (sender) => ({ action: 'synchronize', sender });
  assert.deepEqual(touchOf('pull_request_target', event({ login: 'gardener', id: 42, type: 'User' }), config({ id: 42 })), { kind: 'push', login: 'gardener' });
  assert.deepEqual(touchOf('pull_request_target', event({ login: 'renamed', id: 42, type: 'User' }), config({ id: 42 })), { kind: 'push', login: 'renamed' });
  assert.equal(touchOf('pull_request_target', event({ login: 'renamed', id: 42, type: 'User' }), config()), null);
  assert.equal(touchOf('pull_request_target', event({ login: 'someone', id: 7, type: 'User' }), config({ id: 42 })), null);
});

test('an id in a grant must be a GitHub user id, or the entry is dropped', () => {
  assert.equal(cleanDelegates(config({ id: 42 }))[0].id, 42);
  assert.equal(cleanDelegates(config())[0].id, null);
  for (const id of [0, -1, '42', 4.2, true, null]) {
    const warnings = [];
    assert.deepEqual(cleanDelegates(config({ id }), (m) => warnings.push(m)), [], String(id));
    assert.match(warnings[0], /"id"/);
  }
  assert.deepEqual(identityProblems({ author_association: 'COLLABORATOR', user: { id: 42 } }, { login: 'gardener', id: null }), []);
});

test("the guard's own lookup checks the session's account id when the grant has one", () => {
  assert.equal(grantCovers(config({ id: 42 }), 'gardener', ['approve'], 42), true);
  assert.equal(grantCovers(config({ id: 42 }), 'gardener', ['approve'], 7), false);
  assert.equal(grantCovers(config({ id: 42 }), 'gardener', ['approve']), false);
  assert.equal(grantCovers(config({ id: '42' }), 'gardener', ['approve'], 42), false);
  assert.equal(grantCovers(config(), 'gardener', ['approve'], 7), true);
});

test("the inbox names the grant only for the account it belongs to", async () => {
  const run = (userId) =>
    buildInbox({ client: fakeGitHub(), repo: 'o/r', config: config({ id: 42 }), now: new Date(at(12)), login: 'gardener', userId, evaluate: async () => ({}), branches: () => [], projectCounts: () => ({}) });
  assert.equal((await run(42)).delegate.login, 'gardener');
  const other = await run(7);
  assert.equal(other.delegate, null);
  assert.match(other.error, /account id is 7, not gardener's configured id 42/);
});

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test("pr-wait trusts a delegate's words only with GitHub's access on them, and the id when set", { skip: !python && 'python not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait-identity'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify({ admins: ['owner'], delegates: [{ login: 'gardener', direct: true, id: 42 }, { login: 'other', direct: true, id: '9' }] }));
    const nodes = [
      { author: { login: 'gardener', databaseId: 42 }, authorAssociation: 'COLLABORATOR' },
      { author: { login: 'gardener', databaseId: 42 }, authorAssociation: 'NONE' },
      { author: { login: 'gardener', databaseId: 7 }, authorAssociation: 'COLLABORATOR' },
      { author: { login: 'gardener' }, authorAssociation: 'MEMBER' },
      { author: { login: 'owner' } },
      { author: { login: 'other', databaseId: 9 }, authorAssociation: 'COLLABORATOR' },
    ];
    const code = [
      'import importlib.machinery, importlib.util, json, sys',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
      'loader.exec_module(mod)',
      'print(json.dumps([[mod.trusted(n), mod.is_delegate(n)] for n in json.loads(sys.argv[1])]))',
    ].join('\n');
    const out = spawnSync(python, ['-c', code, JSON.stringify(nodes)], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    // The admin is trusted as before; `other` has a malformed id, so it is dropped.
    assert.deepEqual(JSON.parse(out.stdout), [[true, true], [false, false], [false, false], [false, false], [true, false], [false, false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
