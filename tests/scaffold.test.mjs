import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { adopt, compareVersions, listPacks, planUpdate, protectionBody, scaffold } from '../bin/pipeline.mjs';

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

function existingRepo() {
  const target = fresh();
  mkdirSync(join(target, '.pipeline'), { recursive: true });
  mkdirSync(join(target, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: target });
  writeFileSync(join(target, 'README.md'), '# Mine\n');
  writeFileSync(join(target, '.gitignore'), 'node_modules/\n/out/');
  writeFileSync(join(target, '.gitattributes'), 'dist/** binary\n');
  writeFileSync(join(target, 'docs/PRD.md'), '# Real PRD\n');
  writeFileSync(join(target, '.pipeline/verify.mjs'), '// a project file at a managed path\n');
  return target;
}

test('adopt adds the pipeline to an existing repo without replacing anything', () => {
  const target = existingRepo();
  const { written, kept } = adopt(target, { pack: 'generic', admin: 'owner', project: 'My Project' });

  for (const file of ['README.md', '.gitattributes', 'docs/PRD.md', '.pipeline/verify.mjs']) assert.ok(kept.includes(file), file);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# Mine\n');
  assert.equal(readFileSync(join(target, '.gitattributes'), 'utf8'), 'dist/** binary\n');
  assert.equal(readFileSync(join(target, 'docs/PRD.md'), 'utf8'), '# Real PRD\n');
  assert.equal(readFileSync(join(target, '.pipeline/verify.mjs'), 'utf8'), '// a project file at a managed path\n');

  assert.ok(written.includes('.pipeline/gate.mjs'));
  assert.ok(written.includes('.github/workflows/gate.yml'));
  assert.ok(existsSync(join(target, '.git/hooks/pre-push')));

  const config = JSON.parse(readFileSync(join(target, 'pipeline.config.json'), 'utf8'));
  assert.deepEqual(config.admins, ['owner']);
  assert.equal(config.project, 'My Project');
  assert.doesNotMatch(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), /\{\{/);

  const ignore = readFileSync(join(target, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('/out/'), 'a last line with no newline survives');
  assert.ok(ignore.includes('.pipeline/evidence/'));
  assert.equal(ignore.filter((line) => line === 'node_modules/').length, 1, 'lines are not duplicated');
});

test("update reports an adopted repo's own files as conflicts, and never overwrites them", () => {
  const target = existingRepo();
  adopt(target, { pack: 'generic', admin: 'owner', project: 'x' });
  const { plan } = planUpdate(target);
  assert.deepEqual(plan.conflict, ['.pipeline/verify.mjs']);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.add, []);
});

test('adopt refuses a folder that is not a repo, a linked worktree, or an adopted repo', () => {
  const plain = fresh();
  mkdirSync(plain, { recursive: true });
  assert.throws(() => adopt(plain, { pack: 'generic', admin: 'o', project: 'x' }), /main checkout/);

  const linked = fresh();
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, '.git'), 'gitdir: elsewhere\n');
  assert.throws(() => adopt(linked, { pack: 'generic', admin: 'o', project: 'x' }), /main checkout/);

  const target = existingRepo();
  adopt(target, { pack: 'generic', admin: 'o', project: 'x' });
  assert.throws(() => adopt(target, { pack: 'generic', admin: 'o', project: 'x' }), /already uses the pipeline/);
});

test('adopt keeps an existing pre-push hook', () => {
  const target = existingRepo();
  mkdirSync(join(target, '.git/hooks'), { recursive: true });
  writeFileSync(join(target, '.git/hooks/pre-push'), '#!/bin/sh\n# mine\n');
  const { kept } = adopt(target, { pack: 'generic', admin: 'o', project: 'x' });
  assert.ok(kept.includes('.git/hooks/pre-push'));
  assert.match(readFileSync(join(target, '.git/hooks/pre-push'), 'utf8'), /# mine/);
});
