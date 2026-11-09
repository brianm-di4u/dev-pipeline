// Delegate approvers, PR 5: the guard's identity check, token hygiene, the
// doctor's token line, and the setup script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkCommand, grantCovers, plainComment } from '../template/.claude/hooks/guard.mjs';
import { tokenCheck } from '../bin/pipeline.mjs';

// Contexts stand in for the network lookups: who the session is, and whether the
// working tree names any delegate.
const base = { currentBranch: () => 'feature/x', isOwnPr: () => true };
const asDelegate = (allowed) => ({
  ...base,
  delegateMayPost: (words) => words.every((w) => allowed.includes(w)),
  isDelegateSession: () => true,
  localDelegates: () => true,
});
// A worker in a repo with delegates: the owner's login, so not a delegate.
const worker = { ...base, delegateMayPost: () => false, isDelegateSession: () => false, localDelegates: () => true };
// A repo with no delegates at all.
const nobody = { ...base, delegateMayPost: () => false, isDelegateSession: () => false, localDelegates: () => false };

const POSTS = [
  ['gh pr comment 5 --body "/approve abcdef012345"', ['approve']],
  ['gh issue comment 5 --body "/decide A"', ['decide']],
  ['gh issue comment 5 -b "/rearm"', ['rearm']],
];

test('every session that is not a delegate is still denied the command words', () => {
  for (const [command] of POSTS) {
    assert.match(checkCommand(command, nobody), /Only a human posts/);
    assert.match(checkCommand(command, worker), /Only a human posts/);
  }
  assert.match(checkCommand('gh api repos/o/r/issues/5/comments -f body="/approve abcdef012345"', nobody), /Only a human posts/);
});

test('a repo with no delegates denies the command words without any lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-no-delegates'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify({ admins: ['owner'] }));
    for (const [command] of POSTS) {
      // The default lookup runs here; an empty PATH would make any gh call fail,
      // and the result must be today's deny either way.
      assert.match(checkCommand(command, { ...base, cwd: dir }), /Only a human posts/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a delegate session may post exactly the commands its grant covers', () => {
  for (const [command, words] of POSTS) {
    assert.equal(checkCommand(command, asDelegate(words)), null, command);
  }
  assert.match(checkCommand('gh issue comment 5 --body "/decide A"', asDelegate(['approve'])), /Only a human posts/);
  assert.match(checkCommand('gh pr comment 5 --body "/approve abc /rearm"', asDelegate(['approve'])), /Only a human posts/);
});

// A command that drops the session's token first would make gh fall back to the
// owner's keyring login, and post as the admin.
for (const command of [
  'unset GH_TOKEN; gh pr comment 5 --body "/approve abcdef012345"',
  'env -u GH_TOKEN gh pr comment 5 --body "/approve abcdef012345"',
  'export GH_TOKEN=; gh pr comment 5 --body "/approve abcdef012345"',
  'Remove-Item Env:GH_TOKEN; gh pr comment 5 --body "/approve abcdef012345"',
  '$env:GH_TOKEN=$null; gh pr comment 5 --body "/approve abcdef012345"',
  'GH_HOST=x gh pr comment 5 --body "/approve abcdef012345"',
  'GIT_CONFIG_COUNT=0 gh pr comment 5 --body "/approve abcdef012345"',
  'gh pr comment 5 --body "/approve abcdef012345" && gh pr merge 5',
  'gh pr comment 5 --body "/approve abcdef012345" | cat',
  'echo $(gh pr comment 5 --body "/approve abcdef012345")',
  'gh pr comment 5 --body "/approve abcdef012345"\ngh pr merge 5',
  'gh api repos/o/r/issues/5/comments -f body="/approve abcdef012345"',
  'gh issue create --title x --body "/decide A"',
]) {
  test(`a delegate's command word must be one plain comment: ${command}`, () => {
    assert.match(checkCommand(command, asDelegate(['approve', 'decide', 'rearm'])) ?? '', /Only a human posts|credentials/);
  });
}

test('a plain comment command is recognised', () => {
  assert.equal(plainComment('gh pr comment 5 --body "/approve abcdef012345"'), true);
  assert.equal(plainComment('  gh issue comment 7 -b "/decide A"  '), true);
  assert.equal(plainComment('gh pr comment 5 --body-file body.md'), true);
  assert.equal(plainComment('gh pr review 5 --body "/approve x"'), false);
  assert.equal(plainComment('gh pr comment 5 --body "x"; ls'), false);
});

test('a delegate session gets no other exemption', () => {
  const ctx = asDelegate(['approve', 'decide', 'rearm']);
  for (const command of ['gh auth token', 'git push origin main', 'gh pr merge 5 --admin', 'gh pr review 5 --approve', 'gh secret set X']) {
    assert.ok(checkCommand(command, ctx), command);
  }
});

const config = (grant = {}, extra = {}) => ({
  admins: ['owner'],
  tiers: {},
  delegates: [{ login: 'gardener', approve: true, decide: ['design'], rearm: true, ...grant }],
  ...extra,
});

test('grantCovers reads a grant the way the gate does', () => {
  assert.equal(grantCovers(config(), 'gardener', ['approve']), true);
  assert.equal(grantCovers(config(), 'Gardener', ['approve', 'decide', 'rearm']), true);
  assert.equal(grantCovers(config({ approve: false }), 'gardener', ['approve']), false);
  assert.equal(grantCovers(config({ decide: [] }), 'gardener', ['decide']), false);
  assert.equal(grantCovers(config({ rearm: undefined }), 'gardener', ['rearm']), false);
  assert.equal(grantCovers(config(), 'owner', ['approve']), false, 'an admin session is not a delegate');
  assert.equal(grantCovers(config(), 'stranger', ['approve']), false);
  assert.equal(grantCovers(config({ approve: 'yes' }), 'gardener', ['approve']), false, 'a malformed grant grants nothing');
  assert.equal(grantCovers(config({ decide: ['everything'] }), 'gardener', ['decide']), false);
  assert.equal(grantCovers(config({}, { tiers: { adminOnlyPaths: 'x' } }), 'gardener', ['approve']), false);
  assert.equal(grantCovers({ admins: ['gardener'], delegates: [{ login: 'gardener', approve: true }] }, 'gardener', ['approve']), false);
  assert.equal(grantCovers({ admins: ['owner'] }, 'gardener', ['approve']), false);
});

for (const command of [
  'gh release create v1.0.0',
  'gh release edit v1.0.0 --prerelease=false',
  'gh release delete v1.0.0 --yes',
  'gh release delete-asset v1.0.0 app.zip',
  'gh release upload v1.0.0 app.zip',
  'gh workflow run release.yml -f promote=v1.0.0',
  'gh workflow run release -f action=cut',
  'gh api -X POST repos/o/r/releases -f tag_name=v1',
  'gh api -X PATCH repos/o/r/releases/12 -F draft=false',
  'gh api -X POST repos/o/r/actions/workflows/release.yml/dispatches -f ref=main',
]) {
  test(`a delegate's session can't release: ${command}`, () => {
    assert.ok(checkCommand(command, asDelegate(['approve', 'decide', 'rearm'])), command);
    // Unchanged for everyone else.
    assert.equal(checkCommand(command, nobody), null, command);
    assert.equal(checkCommand(command, worker), null, command);
  });
}

test('only the workflow name decides a workflow run; a numeric id or id dispatch is denied to a delegate', () => {
  const ctx = asDelegate(['approve']);
  assert.equal(checkCommand('gh workflow run ci.yml --ref release/2.6', ctx), null);
  assert.equal(checkCommand('gh workflow run --ref release/2.6 ci.yml', ctx), null);
  assert.ok(checkCommand('gh workflow run 12345', ctx));
  assert.ok(checkCommand('gh api -X POST repos/o/r/actions/workflows/12345/dispatches -f ref=main', ctx));
  assert.equal(checkCommand('gh api -X POST repos/o/r/actions/workflows/ci.yml/dispatches -f ref=main', ctx), null);
});

test('if the session lookup fails, a release write is denied', () => {
  const ctx = { ...base, delegateMayPost: () => false, localDelegates: () => true, isDelegateSession: () => true };
  assert.ok(checkCommand('gh release create v1', ctx));
});

for (const command of ['gh release list', 'gh release view v1.0.0', 'gh release download v1.0.0', 'gh workflow run ci.yml', 'gh api repos/o/r/releases']) {
  test(`release reads are still allowed: ${command}`, () => {
    assert.equal(checkCommand(command, nobody), null);
  });
}

for (const command of [
  'cat .claude/settings.local.json',
  'Get-Content ..\\gwb-garden\\.claude\\settings.local.json',
  'type C:\\GIS\\gwb-garden\\.claude\\Settings.Local.json',
  'git show HEAD:.claude/settings.local.json',
]) {
  test(`with delegates configured, the token file is a credential: ${command}`, () => {
    assert.match(checkCommand(command, worker), /credentials/);
    assert.match(checkCommand(command, asDelegate(['approve'])), /credentials/);
    // A repo with no delegates is as before.
    assert.equal(checkCommand(command, nobody), null);
  });
}

test('the template settings deny reading any local settings file', () => {
  const settings = JSON.parse(readFileSync(new URL('../template/.claude/settings.json', import.meta.url), 'utf8'));
  assert.ok(settings.permissions.deny.includes('Read(**/.claude/settings.local.json)'));
  // A bare pattern only reaches the session's own folder. This one reaches a sibling clone.
  assert.ok(settings.permissions.deny.includes('Read(//**/.claude/settings.local.json)'));
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const response = (login, scopes) => `HTTP/2.0 200 OK\nX-Oauth-Scopes: ${scopes}\n\n{"login":"${login}","id":1}`;

test('without delegates, the token line is exactly as before', () => {
  assert.deepEqual(tokenCheck(response('owner', 'repo, workflow'), { admins: ['owner'] }), {
    level: 'warn',
    name: 'Agent token',
    detail: 'gh holds a broad token (repo, workflow). Give agents the restricted token: see docs/AGENT-TOKEN.md in dev-pipeline.',
  });
  assert.deepEqual(tokenCheck('HTTP/2.0 200 OK\n\n{"login":"owner"}', null), {
    level: 'ok',
    name: 'Agent token',
    detail: 'gh is not using a broad classic or OAuth token',
  });
});

test("in a delegate's session a classic token is expected", () => {
  const result = tokenCheck(response('Gardener', 'public_repo, workflow'), config());
  assert.equal(result.level, 'ok');
  assert.equal(result.name, 'Delegate token');
  assert.match(result.detail, /Gardener is a delegate/);
  // The owner's own broad token still warns in a repo that has delegates.
  assert.equal(tokenCheck(response('owner', 'repo'), config()).level, 'warn');
});

// ---------------------------------------------------------------------------
// tools/setup-delegate.ps1
// ---------------------------------------------------------------------------

const script = fileURLToPath(new URL('../tools/setup-delegate.ps1', import.meta.url));
const source = readFileSync(script, 'utf8');

test('the setup script prompts securely and never prints the token', () => {
  assert.match(source, /Read-Host -AsSecureString/);
  for (const line of source.split('\n')) {
    if (/Write-(Host|Output|Verbose|Information|Warning)|\bEcho\b/i.test(line)) {
      assert.doesNotMatch(line, /\$(plain|secure|Secure|json|envBlock)\b/, line);
    }
  }
  assert.doesNotMatch(source, /param\([^)]*\$Token/is, 'the token is never a parameter');
});

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
test('the setup script writes the settings and hides them from git', { skip: pwsh.status !== 0 && 'pwsh not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-delegate'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    const run = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${script.replaceAll("'", "''")}'; $s = ConvertTo-SecureString 'ghp_TESTONLY' -AsPlainText -Force; Write-DelegateSettings '${dir.replaceAll("'", "''")}' $s 'test-model'`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, /ghp_TESTONLY/);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.env.GH_TOKEN, 'ghp_TESTONLY');
    assert.equal(settings.env.GIT_CONFIG_VALUE_1, '!gh auth git-credential');
    assert.equal(settings.model, 'test-model');
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
    const ignored = spawnSync('git', ['-C', dir, 'check-ignore', '.claude/settings.local.json'], { encoding: 'utf8' });
    assert.equal(ignored.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
