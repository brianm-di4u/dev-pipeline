import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { compareVersions, listPacks, planUpdate, protectionBody, scaffold } from '../bin/pipeline.mjs';

const dirs = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline scaffold '));
  dirs.push(dir);
  return join(dir, 'my app');
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));

for (const pack of listPacks()) {
  test(`scaffolds pack ${pack} into a path with spaces, with no tokens left`, () => {
    const target = fresh();
    scaffold(target, { pack, admin: 'owner', project: 'my app' });

    for (const file of [
      'CLAUDE.md',
      'REVIEW.md',
      'pipeline.config.json',
      'pipeline.lock.json',
      '.claude/settings.json',
      '.claude/hooks/guard.mjs',
      '.pipeline/gate.mjs',
      '.pipeline/verify.mjs',
      '.pipeline/AUTONOMY.md',
      '.github/workflows/ci.yml',
      '.github/workflows/gate.yml',
      '.github/pull_request_template.md',
    ]) {
      assert.ok(existsSync(join(target, file)), file);
    }

    const config = JSON.parse(readFileSync(join(target, 'pipeline.config.json'), 'utf8'));
    assert.deepEqual(config.admins, ['owner']);
    assert.equal(config.project, 'my app');
    assert.equal(config.pack, pack);
    assert.ok(config.tiers.t2Paths.includes('pipeline.config.json'), 'policy protects itself');
    assert.ok(config.tiers.t2Paths.includes('.pipeline/**'));

    const claude = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /^# my app/);
    assert.doesNotMatch(claude, /\{\{/);
    assert.match(claude, /@\.pipeline\/AUTONOMY\.md/);

    const ci = readFileSync(join(target, '.github/workflows/ci.yml'), 'utf8');
    assert.doesNotMatch(ci, /PIPELINE:CI-SETUP/, 'the placeholder is replaced');
  });
}

test('refuses a non-empty directory', () => {
  const target = fresh();
  scaffold(target, { pack: 'generic', admin: 'owner', project: 'x' });
  assert.throws(() => scaffold(target, { pack: 'generic', admin: 'owner', project: 'x' }), /isn't empty/);
});

test('rejects an unknown pack', () => {
  assert.throws(() => scaffold(fresh(), { pack: 'cobol', admin: 'o', project: 'x' }), /Unknown pack/);
});

test('settings.json runs the guard fail-closed, in exec form, on shell and MCP tools', () => {
  const settings = JSON.parse(
    readFileSync(fileURLToPath(new URL('../template/.claude/settings.json', import.meta.url)), 'utf8'),
  );
  const [entry] = settings.hooks.PreToolUse;
  assert.match(entry.matcher, /Bash/);
  assert.match(entry.matcher, /PowerShell/);
  assert.match(entry.matcher, /mcp__/);
  const [hook] = entry.hooks;
  assert.equal(hook.onFailure, 'block');
  assert.equal(hook.command, 'node');
  assert.ok(Array.isArray(hook.args), 'exec form handles paths with spaces');
  assert.ok(!settings.permissions.defaultMode?.includes('bypass'));
});

test('protection requires the gate pinned to GitHub Actions, with admins included', () => {
  assert.equal(protectionBody.enforce_admins, true);
  assert.equal(protectionBody.required_status_checks.strict, true);
  assert.deepEqual(protectionBody.required_status_checks.checks, [{ context: 'pipeline/gate', app_id: 15368 }]);
  assert.equal(protectionBody.allow_force_pushes, false);
  assert.equal(protectionBody.allow_deletions, false);
  assert.equal(protectionBody.required_pull_request_reviews.required_approving_review_count, 0);
});

test('version comparison', () => {
  assert.ok(compareVersions('2.1.317', [2, 1, 295]));
  assert.ok(compareVersions('2.1.295', [2, 1, 295]));
  assert.ok(compareVersions('3.0.0', [2, 1, 295]));
  assert.ok(!compareVersions('2.1.294', [2, 1, 295]));
  assert.ok(!compareVersions('1.9.999', [2, 1, 295]));
});

test('update adds new files, overwrites unmodified ones, and keeps local edits', () => {
  const target = fresh();
  scaffold(target, { pack: 'generic', admin: 'owner', project: 'x' });

  let { plan } = planUpdate(target);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.conflict, []);
  assert.deepEqual(plan.add, []);

  // A locally changed managed file is kept and reported.
  const gate = join(target, '.pipeline/gate.mjs');
  writeFileSync(gate, `${readFileSync(gate, 'utf8')}\n// local fix\n`);
  // A deleted managed file comes back.
  rmSync(join(target, '.pipeline/verify.mjs'));
  // A stale but unmodified file gets updated: simulate by faking its lock entry.
  const guard = join(target, '.claude/hooks/format.mjs');
  writeFileSync(guard, '// old version\n');
  const lockPath = join(target, 'pipeline.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.files['.claude/hooks/format.mjs'] = createHash('sha256').update('// old version\n').digest('hex');
  writeFileSync(lockPath, JSON.stringify(lock));

  ({ plan } = planUpdate(target));
  assert.deepEqual(plan.conflict, ['.pipeline/gate.mjs']);
  assert.deepEqual(plan.add.map((a) => a.file), ['.pipeline/verify.mjs']);
  assert.deepEqual(plan.update.map((a) => a.file), ['.claude/hooks/format.mjs']);
});

test('update never touches project-owned files', () => {
  const target = fresh();
  scaffold(target, { pack: 'generic', admin: 'owner', project: 'x' });
  writeFileSync(join(target, 'CLAUDE.md'), '# Heavily customized\n');
  writeFileSync(join(target, 'docs/PRD.md'), '# Real PRD\n');
  const { plan } = planUpdate(target);
  const touched = [...plan.add, ...plan.update].map((a) => a.file).concat(plan.conflict);
  assert.ok(!touched.includes('CLAUDE.md'));
  assert.ok(!touched.includes('docs/PRD.md'));
});

test('the pre-push hook blocks the default branch and allows others', () => {
  const hook = fileURLToPath(new URL('../template/.pipeline/githooks/pre-push', import.meta.url));
  const push = (ref, env = {}) =>
    spawnSync('sh', [hook], {
      input: `refs/heads/x abc ${ref} def\n`,
      encoding: 'utf8',
      env: { ...process.env, PIPELINE_ADMIN_PUSH: '', ...env },
    }).status;
  assert.equal(push('refs/heads/main'), 1);
  assert.equal(push('refs/heads/master'), 1);
  assert.equal(push('refs/heads/feature'), 0);
  assert.equal(push('refs/heads/main', { PIPELINE_ADMIN_PUSH: '1' }), 0);
});

test('init --no-github produces a committed repo that passes classify', () => {
  const target = fresh();
  const output = execFileSync(
    'node',
    [cli, 'init', target, '--pack', 'generic', '--no-github', '--admin', 'owner'],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } },
  );
  assert.match(output, /Scaffolded/);
  assert.ok(existsSync(join(target, '.git/hooks/pre-push')));
  const log = execFileSync('git', ['log', '--oneline'], { cwd: target, encoding: 'utf8' });
  assert.match(log, /Start from dev-pipeline template/);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
  assert.equal(status, '', 'working tree is clean');
  const classified = JSON.parse(
    execFileSync('node', ['.pipeline/gate.mjs', 'classify', '--base', 'HEAD'], { cwd: target, encoding: 'utf8' }),
  );
  assert.equal(classified.paths.length, 0);
});
