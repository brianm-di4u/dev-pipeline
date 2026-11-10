// Follow-ups from the sandbox run: the delegate's token scopes, commands aimed at
// another repo, and a `since` that keeps a delegate's earlier commands out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkCommand, grantCovers, targetRepo } from '../template/.claude/hooks/guard.mjs';
import { authority, cleanDelegates } from '../template/.pipeline/lib/authority.mjs';
import { decisionProblems, findApproval, rearmProblems } from '../template/.pipeline/lib/contract.mjs';
import { tokenCheck } from '../bin/pipeline.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = (grant = {}) => ({ admins: ['owner'], tiers: {}, delegates: [{ login: 'gardener', approve: true, decide: ['design'], rearm: true, ...grant }] });
const at = (h, m = 0) => `2026-11-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const say = (body, time, login = 'gardener') => ({ body, user: { login, type: 'User' }, created_at: time, updated_at: time });
const hash = 'abcdef012345'.padEnd(64, '0');

// ---------------------------------------------------------------------------
// The token's scopes, and signing in as the delegate.
// ---------------------------------------------------------------------------

test("the docs, the setup script and doctor name the delegate's three scopes", () => {
  const doc = read('docs/AGENT-TOKEN.md');
  assert.match(doc, /`public_repo`, `workflow` and `read:org` scopes/);
  assert.match(doc, /private window or a separate browser profile, and sign out/);
  assert.match(read('tools/setup-delegate.ps1'), /public_repo, workflow and read:org scopes/);
  const result = tokenCheck('HTTP/2.0 200 OK\nX-Oauth-Scopes: public_repo, read:org, workflow\n\n{"login":"gardener"}', config());
  assert.equal(result.level, 'ok');
  assert.match(result.detail, /public_repo, workflow and read:org/);
});

// ---------------------------------------------------------------------------
// The guard: a grant covers only the working directory's own repo.
// ---------------------------------------------------------------------------

test('the target repo of a gh command', () => {
  const tokens = (command) => command.split(' ');
  assert.equal(targetRepo(tokens('gh pr comment 5 --body x'), {}), null);
  assert.equal(targetRepo(tokens('gh pr comment 5 --repo other/repo --body x'), {}), 'other/repo');
  assert.equal(targetRepo(tokens('gh pr comment 5 -R other/repo'), {}), 'other/repo');
  assert.equal(targetRepo(tokens('gh pr comment 5 --repo=other/repo'), {}), 'other/repo');
  assert.equal(targetRepo(tokens('gh pr comment https://github.com/other/repo/pull/5 --body x'), {}), 'other/repo');
  assert.equal(targetRepo(tokens('gh issue comment https://github.com/o/r/issues/9 --body x'), {}), 'o/r');
  assert.equal(targetRepo(tokens('gh pr comment 5 --body x'), { GH_REPO: 'env/repo' }), 'env/repo');
});

test('a delegate command aimed at another repo is denied; one at the working repo goes on to the grant', () => {
  const seen = [];
  const ctx = {
    currentBranch: () => 'feature/x',
    isOwnPr: () => true,
    localDelegates: () => true,
    isDelegateSession: () => true,
    // Stands in for the lookup: the working directory is o/r.
    delegateMayPost: (words, cwd, target) => (seen.push(target), !target || target.toLowerCase() === 'o/r'),
  };
  assert.equal(checkCommand('gh pr comment 5 --body "/approve abcdef012345"', ctx), null);
  assert.equal(checkCommand('gh pr comment 5 --repo O/R --body "/approve abcdef012345"', ctx), null);
  assert.match(checkCommand('gh pr comment 5 --repo other/repo --body "/approve abcdef012345"', ctx), /Only a human posts/);
  assert.match(checkCommand('gh pr comment https://github.com/other/repo/pull/5 --body "/approve abcdef012345"', ctx), /Only a human posts/);
  assert.deepEqual(seen, [process.env.GH_REPO || null, 'O/R', 'other/repo', 'other/repo']);
});

// ---------------------------------------------------------------------------
// since: a delegate's commands count only from its grant's start.
// ---------------------------------------------------------------------------

test('since is validated with the rest of the grant', () => {
  assert.equal(cleanDelegates(config({ since: at(10) })).at(0).since, at(10));
  assert.equal(cleanDelegates(config()).at(0).since, null);
  for (const since of ['yesterday', '2026-11-10', 1731196800, '2026-11-10T10:00:00', '2026-13-40T99:00:00Z']) {
    const warnings = [];
    assert.deepEqual(cleanDelegates(config({ since }), (m) => warnings.push(m)), [], String(since));
    assert.match(warnings[0], /"since"/);
  }
  assert.equal(grantCovers(config({ since: at(10) }), 'gardener', ['approve']), true);
  assert.equal(grantCovers(config({ since: 'soon' }), 'gardener', ['approve']), false);
});

const ctx = {
  flags: { adminOnly: [], symlinks: [], scripts: [], external: false, workflows: [] },
  author: 'owner',
  commitLogins: ['owner'],
  touches: [],
  suspended: false,
  suspensions: [],
};

test('a delegate approval posted before since never counts; one after it does', () => {
  const cfg = authority(config({ since: at(10) }));
  assert.equal(findApproval([say('/approve abcdef012345', at(9, 59))], cfg, hash, ctx), null);
  assert.equal(findApproval([say('/approve abcdef012345', at(10))], cfg, hash, ctx).role, 'delegate');
  // An admin's approval is unaffected.
  assert.equal(findApproval([say('/approve abcdef012345', at(9), 'owner')], cfg, hash, ctx).role, 'admin');
  // Without since, an early approval counts, which is the case since is for.
  assert.equal(findApproval([say('/approve abcdef012345', at(9))], authority(config()), hash, ctx).role, 'delegate');
});

test('a delegate decide or re-arm posted before since never counts', () => {
  const cfg = authority(config({ since: at(10) }));
  const marker = { body: '<!-- pipeline:decision-class design -->', user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: at(8, 1), updated_at: at(8, 1) };
  const events = [{ event: 'labeled', label: { name: 'decision-needed' }, actor: { login: 'owner' }, created_at: at(8) }];
  const early = say('/decide A', at(9));
  const reasons = decisionProblems(early, cfg, [marker, early], { suspended: false, suspensions: [], issueAuthor: 'owner', events });
  assert.ok(reasons.some((r) => /before gardener's grant began/.test(r)), reasons.join('; '));
  const offer = { body: '<!-- pipeline:delegate-rearm-ok -->', user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: at(8), updated_at: at(8) };
  const rearm = say('/rearm', at(9));
  assert.ok(rearmProblems(rearm, cfg, [offer, rearm], { suspensions: [] }).some((r) => /before gardener's grant began/.test(r)));
});

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test('pr-wait drops a delegate entry with a malformed since', { skip: !python && 'python not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait-since'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify({ admins: ['owner'], delegates: [{ login: 'bad', direct: true, since: 'soon' }, { login: 'good', direct: true, since: at(10) }] }));
    const code = [
      'import importlib.machinery, importlib.util, json',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
      'loader.exec_module(mod)',
      'print(json.dumps(sorted(mod.DELEGATES)))',
    ].join('\n');
    const out = spawnSync(python, ['-c', code], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), ['good']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
