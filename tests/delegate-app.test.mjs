// A delegate can be a GitHub App installation. Its command counts only when GitHub
// records the comment as posted through that App. With no delegates, or a user
// delegate, nothing changes: tests compare against a frozen copy from before.
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as beforeContract from './fixtures/before-app/contract.mjs';
import { evaluateGate as evaluateBefore } from './fixtures/before-app/gate-core.mjs';
import { eligible as eligibleBefore } from './fixtures/before-app/queue.mjs';
import { appDelegateChecks } from '../bin/pipeline.mjs';
import { checkCommand, grantCovers } from '../template/.claude/hooks/guard.mjs';
import * as hook from '../template/.claude/hooks/delegate-token.mjs';
import { grantMismatch } from '../template/.pipeline/garden.mjs';
import { touchOf } from '../template/.pipeline/gate.mjs';
import { authority, cleanDelegates } from '../template/.pipeline/lib/authority.mjs';
import { loadConfig } from '../template/.pipeline/lib/config.mjs';
import { actorOf, decisionProblems, delegateRefusals, findApproval, findDecision, rearmBy, renderClassMarker } from '../template/.pipeline/lib/contract.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { eligible } from '../template/.pipeline/lib/queue.mjs';
import { BLANKED, delegateEnv, mergeSettings } from '../tools/setup-delegate-app.mjs';

const APP = { id: 424242, slug: 'gardener-app' };
const BOT = 'gardener-app[bot]';
const at = (h, m = 0) => `2026-11-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const config = (grant = {}, extra = {}) => ({ admins: ['owner'], tiers: {}, delegates: [{ app: APP, approve: true, decide: ['design'], rearm: true, direct: true, ...grant }], ...extra });
const appComment = (body, extra = {}) => ({
  body,
  user: { login: BOT, id: 9001, type: 'Bot' },
  performed_via_github_app: { id: APP.id, slug: APP.slug },
  author_association: 'NONE',
  created_at: at(10),
  updated_at: at(10),
  ...extra,
});
const hash = 'abcdef012345'.padEnd(64, '0');
const ctx = { flags: { adminOnly: [], symlinks: [], scripts: [], external: false, workflows: [] }, author: 'owner', commitLogins: ['owner'], touches: [], suspended: false, suspensions: [] };

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

test('an App entry is kept, acting as <slug>[bot]', () => {
  const [grant] = cleanDelegates(config());
  assert.equal(grant.login, BOT);
  assert.deepEqual(grant.app, APP);
  assert.equal(authority(config()).delegateOf('Gardener-App[bot]')?.app.id, APP.id);
  assert.equal(cleanDelegates({ admins: ['owner'], delegates: [{ login: 'gardener' }] })[0].app, null);
});

test('a malformed App entry is dropped with a warning, never thrown', () => {
  for (const entry of [
    { app: APP, login: 'gardener' },
    {},
    { app: null },
    { app: { id: 0, slug: 'x' } },
    { app: { id: '1', slug: 'x' } },
    { app: { id: 1 } },
    { app: { id: 1, slug: 'bad slug' } },
    { app: { id: 1, slug: 'x', owner: 'y' } },
    { app: { id: 15368, slug: 'something' } },
    { app: { id: 1, slug: 'github-actions' } },
    { app: { id: 1, slug: 'dependabot' } },
    { app: APP, id: 9001 },
  ]) {
    const warnings = [];
    const kept = cleanDelegates({ admins: ['owner'], trustedBots: ['dependabot[bot]'], delegates: [entry] }, (m) => warnings.push(m));
    assert.deepEqual(kept, [], JSON.stringify(entry));
    assert.equal(warnings.length, 1, JSON.stringify(entry));
  }
  // The same App twice keeps the first.
  const warnings = [];
  assert.equal(cleanDelegates({ admins: ['owner'], delegates: [{ app: APP }, { app: { ...APP, slug: 'other' } }] }, (m) => warnings.push(m)).length, 1);
  assert.match(warnings[0], /listed twice/);
});

test('cleaning twice keeps App and user entries alike, and the floor through the real path', () => {
  const both = { admins: ['owner'], tiers: {}, delegates: [{ app: APP, approve: true, since: '2026-11-10T00:00:00Z' }, { login: 'gardener', approve: true, id: 42 }, { login: 'helper' }] };
  const once = cleanDelegates(both);
  assert.equal(once.length, 3);
  const warnings = [];
  assert.deepEqual(cleanDelegates({ ...both, delegates: once }, (m) => warnings.push(m)), once);
  assert.deepEqual(warnings, []);
  // A login on an App entry other than its own bot is still refused.
  assert.deepEqual(cleanDelegates({ admins: ['owner'], delegates: [{ app: APP, login: 'someone' }] }), []);
  const dir = mkdtempSync(join(tmpdir(), 'app-idempotent-'));
  try {
    const file = join(dir, 'pipeline.config.json');
    const template = JSON.parse(readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8'));
    writeFileSync(file, JSON.stringify({ ...template, ...both }));
    const auth = authority(loadConfig(file, { warn: () => {} }));
    assert.equal(auth.delegates.length, 3);
    assert.ok(auth.adminOnlyPaths.includes('.pipeline/**'));
    assert.equal(grantCovers(loadConfig(file, { warn: () => {} }), BOT, ['approve'], null, APP.id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Recognition.
// ---------------------------------------------------------------------------

test('the recognition matrix: only the configured App, through itself, unedited', () => {
  const cfg = authority(config());
  const approve = (extra) => appComment('/approve abcdef012345', extra);
  assert.equal(findApproval([approve()], cfg, hash, ctx)?.role, 'delegate');
  const refused = (comment, pattern) => {
    assert.equal(findApproval([comment], cfg, hash, ctx), null);
    if (pattern) assert.match(delegateRefusals([comment], cfg, hash, ctx)[0].reasons.join('; '), pattern);
  };
  refused(approve({ performed_via_github_app: { id: 777, slug: 'other' } }), /through App 424242 \(777\)/);
  refused(approve({ performed_via_github_app: undefined }), /no App recorded/);
  refused(approve({ user: { login: BOT, type: 'User' } }), /not posted by gardener-app\[bot\], an App/);
  // The pipeline's own bot, and another bot, are never the delegate.
  assert.equal(actorOf(approve({ user: { login: 'github-actions[bot]', type: 'Bot' }, performed_via_github_app: { id: 15368 } }), cfg), null);
  assert.equal(actorOf(approve({ user: { login: 'someone-else[bot]', type: 'Bot' } }), cfg), null);
  // Another bot posting the same login text as a user isn't a Bot, so it's refused above; edited never counts.
  assert.equal(actorOf(approve({ updated_at: at(11) }), cfg), null);
  // A user account with the App's login can't exist: logins can't hold brackets.
  assert.equal(cleanDelegates({ admins: ['owner'], delegates: [{ login: BOT }] }).length, 0);
});

test("an App delegate's decide, re-arm and direct issue need the same proof", () => {
  const cfg = authority(config());
  const marker = { body: renderClassMarker('design'), user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: at(8, 1), updated_at: at(8, 1) };
  const events = [{ event: 'labeled', label: { name: 'decision-needed' }, actor: { login: 'owner' }, created_at: at(8) }];
  const issueCtx = { issueAuthor: 'owner', events, suspended: false, suspensions: [] };
  const decide = appComment('/decide A');
  assert.equal(findDecision([marker, decide], cfg, issueCtx)?.role, 'delegate');
  const forged = appComment('/decide A', { performed_via_github_app: { id: 1 } });
  assert.match(decisionProblems(forged, cfg, [marker, forged], issueCtx).join('; '), /through App/);
  const offer = { body: '<!-- pipeline:delegate-rearm-ok -->', user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: at(8), updated_at: at(8) };
  assert.equal(rearmBy([offer, appComment('/rearm')], cfg, { suspensions: [] })?.role, 'delegate');
  assert.equal(rearmBy([offer, appComment('/rearm', { performed_via_github_app: null })], cfg, { suspensions: [] }), null);
  const issue = (extra = {}) => ({ number: 1, state: 'open', labels: [{ name: 'ready' }], user: { login: BOT, type: 'Bot' }, performed_via_github_app: { id: APP.id }, ...extra });
  assert.equal(eligible(issue(), config()), true);
  assert.equal(eligible(issue({ performed_via_github_app: undefined }), config()), false);
  assert.equal(eligible(issue(), config({ direct: false })), false);
});

test("the App's pushes and edits mark a PR; the pipeline's own bot never does", () => {
  const event = (sender) => ({ action: 'synchronize', sender });
  assert.deepEqual(touchOf('pull_request_target', event({ login: BOT, type: 'Bot' }), config()), { kind: 'push', login: BOT });
  assert.equal(touchOf('pull_request_target', event({ login: 'github-actions[bot]', type: 'Bot' }), config()), null);
  assert.equal(touchOf('pull_request_target', event({ login: 'other[bot]', type: 'Bot' }), config()), null);
  // A user delegate's grant never matches a Bot sender.
  assert.equal(touchOf('pull_request_target', event({ login: 'gardener', type: 'Bot' }), { admins: ['owner'], delegates: [{ login: 'gardener' }] }), null);
});

// ---------------------------------------------------------------------------
// Unchanged without delegates, and with a user delegate.
// ---------------------------------------------------------------------------

const CONTRACT = '## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert the squash commit.\n';
const verdict = `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`;
const say = (body, login, extra = {}) => ({ body, user: { login, type: 'User' }, author_association: 'COLLABORATOR', created_at: at(10), updated_at: at(10), ...extra });
const CONFIGS = [
  { admins: ['owner'], tiers: {}, merge: { t1: 'auto', t2: 'human' } },
  { admins: ['owner'], tiers: {}, merge: { t1: 'auto', t2: 'human' }, delegates: [{ login: 'gardener', approve: true, decide: ['design'], rearm: true, direct: true }] },
  { admins: ['owner'], tiers: {}, merge: { t1: 'auto', t2: 'human' }, delegates: [{ login: 'gardener', approve: true, id: 42 }] },
];
const COMMENTS = [
  [],
  [say('/approve abcdef012345', 'owner')],
  [say('/approve abcdef012345', 'gardener')],
  [say('/approve abcdef012345', 'gardener', { user: { login: 'gardener', id: 42, type: 'User' } })],
  [say('/approve abcdef012345', 'gardener', { author_association: 'NONE' })],
  [appComment('/approve abcdef012345', { user: { login: 'gardener', type: 'Bot' } })],
  [appComment('/approve abcdef012345')],
  [say('/approve abcdef012345', 'gardener', { user: { login: 'gardener', type: 'Bot' } })],
];

test('with no delegates or a user delegate, the gate returns exactly what it did before', () => {
  for (const cfg of CONFIGS) {
    for (const comments of COMMENTS) {
      for (const changes of [[{ path: 'src/auth/a.js', oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' }], [{ path: 'src/a.js', oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' }]]) {
        const input = { pr: { author: 'owner', body: `${CONTRACT}\n${verdict}`, draft: false, base: 'main' }, changes, hash, config: cfg, verify: 'success', comments, commitLogins: ['owner'], suspended: false, suspensions: [] };
        assert.deepEqual(evaluateGate(input), evaluateBefore(input), JSON.stringify({ cfg, comments }));
      }
      for (const fn of ['findDecision', 'rearmBy']) {
        assert.deepEqual(
          { findDecision, rearmBy }[fn](comments.map((c) => ({ ...c, body: fn === 'findDecision' ? '/decide A' : '/rearm' })), cfg, { events: [], suspensions: [], suspended: false }),
          beforeContract[fn](comments.map((c) => ({ ...c, body: fn === 'findDecision' ? '/decide A' : '/rearm' })), cfg, { events: [], suspensions: [], suspended: false }),
        );
      }
      for (const comment of comments) assert.equal(actorOf(comment, cfg), beforeContract.actorOf(comment, cfg));
    }
    for (const user of [{ login: 'gardener', type: 'User' }, { login: 'gardener', type: 'Bot' }, { login: 'owner' }]) {
      const issue = { number: 1, state: 'open', labels: [{ name: 'ready' }], user, author_association: 'COLLABORATOR' };
      assert.equal(eligible(issue, cfg), eligibleBefore(issue, cfg));
    }
  }
});

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

test("the guard's grant check: an App grant covers only that App's session", () => {
  assert.equal(grantCovers(config(), BOT, ['approve'], null, APP.id), true);
  assert.equal(grantCovers(config(), BOT, ['approve'], null, 777), false);
  assert.equal(grantCovers(config(), BOT, ['approve']), false);
  assert.equal(grantCovers(config({ id: 9001 }), BOT, ['approve'], null, APP.id), false);
  assert.equal(grantCovers(config({}, { trustedBots: [BOT] }), BOT, ['approve'], null, APP.id), false);
  assert.equal(grantCovers({ admins: ['owner'], delegates: [{ app: { id: 15368, slug: 'gardener-app' } }] }, BOT, ['approve'], null, 15368), false);
  // A user grant is untouched by an App id.
  assert.equal(grantCovers({ admins: ['owner'], delegates: [{ login: 'gardener', approve: true }] }, 'gardener', ['approve'], null, APP.id), true);
});

for (const command of [
  'cat ~/.pipeline-delegates/gardener-app/app.pem',
  'Get-Content $env:USERPROFILE\\.pipeline-delegates\\gardener-app\\o-r\\hosts.yml',
  'echo $PIPELINE_DELEGATE_DIR',
  'ls $GH_CONFIG_DIR',
  'node .claude/hooks/delegate-token.mjs',
  'type app.pem',
  'GH_ENTERPRISE_TOKEN=x gh api user',
  'gh auth token',
  'gh auth status --show-token',
]) {
  test(`any session is denied: ${command}`, () => {
    assert.ok(checkCommand(command, { currentBranch: () => 'feature/x', isOwnPr: () => true, localDelegates: () => false }), command);
  });
}

// ---------------------------------------------------------------------------
// The token hook.
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const TOKEN = 'ghs_' + 'T'.repeat(36);

function delegateDir() {
  const base = mkdtempSync(join(tmpdir(), 'delegate-app-'));
  const dir = join(base, 'o-r');
  mkdirSync(dir);
  writeFileSync(join(base, 'app.pem'), PEM);
  writeFileSync(join(dir, 'delegate.json'), JSON.stringify({ appId: APP.id, slug: APP.slug, installationId: 77, repo: 'o/r' }));
  return { base, dir };
}

function fakeFetch({ installed = { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' }, mintStatus = 201, appId = APP.id } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/app/installations/77')) return { ok: true, status: 200, json: async () => ({ app_id: appId, permissions: installed }) };
    if (url.endsWith('/access_tokens')) {
      return { ok: mintStatus < 300, status: mintStatus, json: async () => ({ token: TOKEN, expires_at: new Date(Date.parse(at(13))).toISOString(), permissions: JSON.parse(init.body).permissions }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls };
}

test('the JWT is RS256, issued 60 seconds back, valid for 9 minutes, signed by the key', () => {
  const now = Date.parse(at(12));
  const jwt = hook.appJwt(APP.id, PEM, now);
  const [head, body, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.iss, String(APP.id));
  assert.equal(claims.iat, now / 1000 - 60);
  assert.equal(claims.exp - now / 1000, 540);
  assert.ok(verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')));
});

test('a token is minted with 20 minutes or less left, and not before', () => {
  const now = Date.parse(at(12));
  assert.equal(hook.needsToken(null, now), true);
  assert.equal(hook.needsToken({ expiresAt: new Date(now + 21 * 60000).toISOString() }, now), false);
  assert.equal(hook.needsToken({ expiresAt: new Date(now + 19 * 60000).toISOString() }, now), true);
});

test('only the allowed permissions are asked for; anything more refuses the mint', () => {
  assert.deepEqual(hook.requestedPermissions({ issues: 'write', metadata: 'read' }), { issues: 'write', metadata: 'read' });
  for (const extra of [{ checks: 'write' }, { statuses: 'write' }, { administration: 'read' }, { secrets: 'read' }, { environments: 'write' }, { pages: 'write' }, { deployments: 'write' }, { repository_hooks: 'write' }, { actions: 'write' }]) {
    assert.throws(() => hook.requestedPermissions({ issues: 'write', ...extra }), /must not hold/, JSON.stringify(extra));
  }
});

test('the hook writes the token where gh reads it, by rename, and prints nothing secret', async () => {
  const { base, dir } = delegateDir();
  const { fetcher, calls } = fakeFetch();
  const writes = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => (writes.push(String(chunk)), true);
  process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
  try {
    assert.equal(await hook.main({ PIPELINE_DELEGATE_DIR: dir }, { fetcher, now: Date.parse(at(12)) }), 0);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  try {
    assert.match(readFileSync(join(dir, 'hosts.yml'), 'utf8'), new RegExp(`oauth_token: ${TOKEN}`));
    assert.match(readFileSync(join(dir, 'hosts.yml'), 'utf8'), /user: gardener-app\[bot\]/);
    const identity = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
    assert.equal(identity.login, BOT);
    assert.equal(JSON.stringify(identity).includes(TOKEN), false);
    const mint = JSON.parse(calls.find((c) => c.url.endsWith('/access_tokens')).init.body);
    assert.deepEqual(mint.repositories, ['r']);
    assert.equal(writes.join('').includes(TOKEN) || writes.join('').includes('PRIVATE KEY'), false);
    // Fresh enough: nothing is fetched again.
    const again = fakeFetch();
    await hook.main({ PIPELINE_DELEGATE_DIR: dir }, { fetcher: again.fetcher, now: Date.parse(at(12)) });
    assert.equal(again.calls.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('if it cannot mint, the hook leaves a token GitHub refuses, never none, and says why without a secret', async () => {
  for (const options of [{ mintStatus: 403 }, { installed: { checks: 'write' } }, { appId: 1 }]) {
    const { base, dir } = delegateDir();
    writeFileSync(join(dir, 'hosts.yml'), 'old token');
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ expiresAt: at(12, 5) }));
    const errors = [];
    const err = process.stderr.write;
    process.stderr.write = (chunk) => (errors.push(String(chunk)), true);
    try {
      await hook.main({ PIPELINE_DELEGATE_DIR: dir }, { fetcher: fakeFetch(options).fetcher, now: Date.parse(at(12)) });
    } finally {
      process.stderr.write = err;
    }
    try {
      // gh falls back to the owner's keyring login when hosts.yml holds no token.
      const hosts = readFileSync(join(dir, 'hosts.yml'), 'utf8');
      assert.ok(hosts.includes(`oauth_token: ${hook.NO_TOKEN}`) && !hosts.includes('old token'), JSON.stringify(options));
      assert.match(hosts, /user: gardener-app\[bot\]/);
      assert.equal(existsSync(join(dir, 'identity.json')), false);
      assert.match(errors.join(''), /^delegate token: /);
      assert.equal(errors.join('').includes('PRIVATE KEY'), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  // Not a delegate clone: nothing happens.
  assert.equal(await hook.main({}, { fetcher: () => assert.fail('no fetch') }), 0);
  // A missing hosts.yml is replaced at once, before anything else is tried.
  const { base, dir } = delegateDir();
  try {
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ expiresAt: at(14) }));
    await hook.main({ PIPELINE_DELEGATE_DIR: dir }, { fetcher: () => assert.fail('no fetch while fresh'), now: Date.parse(at(12)) });
    assert.ok(readFileSync(join(dir, 'hosts.yml'), 'utf8').includes(hook.NO_TOKEN));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The session's settings, and a failure that stays closed.
// ---------------------------------------------------------------------------

test("the session's settings blank every token variable and clear git's helpers first", () => {
  const env = delegateEnv({ dir: 'D', login: BOT, botId: 9001 });
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GIT_ASKPASS']) assert.equal(env[name], '', name);
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
  assert.equal(env.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
  assert.equal(env.GIT_AUTHOR_EMAIL, '9001+gardener-app[bot]@users.noreply.github.com');
  const merged = mergeSettings({ env: { GH_TOKEN: 'old', OTHER: 'x', GIT_CONFIG_KEY_5: 'stale' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }, env, 'm');
  assert.equal(merged.env.GH_TOKEN, '');
  assert.equal(merged.env.OTHER, 'x');
  assert.equal('GIT_CONFIG_KEY_5' in merged.env, false);
  assert.match(JSON.stringify(merged.hooks.PreToolUse[0]), /delegate-token\.mjs/);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.ok(BLANKED.includes('GITHUB_ENTERPRISE_TOKEN'));
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const hasGh = spawnSync('gh', ['--version']).status === 0;

// These tests run credential helpers, so they start from an environment with no
// token, no git config and no credential settings of whoever runs them, and they
// never put a helper's output in an assertion message.
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GH_|GITHUB_|GIT_|GCM_)/i.test(name) && !/TOKEN|ASKPASS|CREDENTIAL/i.test(name)));

test("with no valid token, git never asks the owner's stored credentials", { skip: !hasGit && 'git not installed' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'delegate-closed-'));
  try {
    const marker = join(scratch, 'decoy-called').replaceAll('\\', '/');
    const script = join(scratch, 'decoy.sh').replaceAll('\\', '/');
    writeFileSync(script, `echo called > '${marker}'\necho username=owner\necho password=owner-secret\n`);
    // Stands in for the owner's stored credentials, general and for GitHub.
    const global = join(scratch, 'global.gitconfig');
    const decoy = `!sh '${script}'`;
    writeFileSync(global, `[credential]\n\thelper = ${decoy}\n[credential "https://github.com"]\n\thelper = ${decoy}\n`);
    const ghDir = join(scratch, 'gh');
    mkdirSync(ghDir);
    // What the hook leaves when it can't mint.
    hook.clearToken(ghDir, BOT);
    const base = { ...cleanEnv(), GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', HOME: scratch, USERPROFILE: scratch };
    const fill = (env) => spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
    // The control: without the delegate's settings, the decoy answers.
    const control = fill({ ...base, GIT_TERMINAL_PROMPT: '0' });
    assert.ok(control.stdout.includes('password=owner-secret') && existsSync(marker), 'without the delegate settings, the decoy should answer');
    rmSync(marker, { force: true });
    const closed = fill({ ...base, ...delegateEnv({ dir: ghDir, login: BOT, botId: 9001 }) });
    const password = /^password=(.*)$/m.exec(closed.stdout)?.[1] ?? null;
    // Whatever git gets is the token GitHub refuses, never a stored credential.
    assert.ok(password === null || password === hook.NO_TOKEN, 'git got a credential other than the refused placeholder');
    assert.equal(existsSync(marker), false, 'the decoy helper was asked');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('with no valid token, gh fails as nobody rather than as the owner', { skip: !hasGh && 'gh not installed' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'delegate-gh-'));
  try {
    hook.clearToken(scratch, BOT);
    const env = { ...cleanEnv(), HOME: scratch, USERPROFILE: scratch, ...delegateEnv({ dir: scratch, login: BOT, botId: 9001 }) };
    // A read that would name whoever gh is logged in as. It must be refused.
    const who = spawnSync('gh', ['api', 'user', '--jq', '.login'], { env, encoding: 'utf8', timeout: 30000 });
    assert.ok(who.status !== 0, 'gh api user should fail');
    assert.ok(/Bad credentials/.test(`${who.stdout}${who.stderr}`) && !/"login"/.test(who.stdout), 'gh should be refused, not answer as someone');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doctor, whoami, pr-wait.
// ---------------------------------------------------------------------------

test("doctor checks an App delegate's clone", () => {
  const settings = mergeSettings({}, delegateEnv({ dir: 'D', login: BOT, botId: 9001 }));
  const good = appDelegateChecks({ settings, processEnv: {}, keyExists: true, access: 0o40700, identity: { permissions: { issues: 'write' } } });
  assert.ok(good.every((c) => c.level === 'ok'), JSON.stringify(good));
  const bad = appDelegateChecks({
    settings: { env: { GH_TOKEN: 'x' } },
    processEnv: { GH_ENTERPRISE_TOKEN: 'y', GCM_INTERACTIVE: 'always' },
    keyExists: true,
    access: 'C:\\x Everyone:(R)',
    identity: { permissions: { checks: 'write' } },
  });
  const byName = Object.fromEntries(bad.map((c) => [c.name, c]));
  assert.equal(byName['Delegate token variables'].level, 'fail');
  assert.match(byName['Inherited credentials'].detail, /GH_ENTERPRISE_TOKEN, GCM_INTERACTIVE/);
  assert.equal(byName['Git credentials'].level, 'fail');
  assert.equal(byName['Token hook'].level, 'fail');
  assert.match(byName['App key access'].detail, /other users/);
  assert.equal(byName['App permissions'].level, 'fail');
});

test('whoami names the grant only for its own App or account', () => {
  const [app] = cleanDelegates(config());
  assert.equal(grantMismatch(app, null, APP.id), null);
  assert.match(grantMismatch(app, null, 777), /isn't App 424242/);
  const [user] = cleanDelegates({ admins: ['owner'], delegates: [{ login: 'gardener', id: 42 }] });
  assert.equal(grantMismatch(user, 42, null), null);
  assert.match(grantMismatch(user, 7, null), /not gardener's configured id 42/);
});

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test("pr-wait trusts an App delegate's comment only on GitHub's REST record of the App", { skip: !python && 'python not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait-app'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify(config()));
    const node = { databaseId: 5, author: { login: 'gardener-app', __typename: 'Bot' } };
    const record = (extra) => ({ user: { login: BOT, type: 'Bot' }, performed_via_github_app: { id: APP.id }, ...extra });
    const cases = [
      [node, record()],
      [node, record({ performed_via_github_app: { id: 1 } })],
      [node, record({ performed_via_github_app: null })],
      [node, null],
      [{ ...node, author: { login: 'gardener-app', __typename: 'User' } }, record()],
    ];
    const code = [
      'import importlib.machinery, importlib.util, json, sys',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
      'loader.exec_module(mod)',
      'out = []',
      'for node, record in json.loads(sys.argv[1]):',
      '    rest = None if record is None else (lambda _id, r=record: r)',
      '    out.append([mod.trusted(node, rest), mod.is_delegate(node, rest)])',
      'print(json.dumps(out))',
    ].join('\n');
    const run = spawnSync(python, ['-c', code, JSON.stringify(cases)], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [[true, true], [false, false], [false, false], [false, false], [false, false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
