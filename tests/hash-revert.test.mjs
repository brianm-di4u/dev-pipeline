import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { changeSet, git } from '../template/.pipeline/lib/git.mjs';
import { claimedRevert, verifyCleanRevert } from '../template/.pipeline/lib/revert.mjs';
import { scriptsChanged } from '../template/.pipeline/lib/tier.mjs';

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline hash '));
  dirs.push(dir);
  const run = (...args) => git(args, dir);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Test');
  run('config', 'user.email', 'test@example.com');
  run('config', 'core.autocrlf', 'false');
  const write = (path, content) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message) => {
    run('add', '-A');
    run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD').trim();
  };
  return { dir, run, write, commit };
}

const config = { tiers: { t2Paths: ['.github/**', 'pipeline.config.json'] } };

test('whitespace-only changes alter the hash', () => {
  const r = repo();
  r.write('a.js', 'const a = 1;\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  r.write('a.js', 'const a = 2;\n');
  r.commit('change');
  const before = changeSet('main', 'HEAD', r.dir).hash;
  r.write('a.js', 'const a  = 2;\n');
  r.commit('whitespace');
  assert.notEqual(changeSet('main', 'HEAD', r.dir).hash, before);
});

test('a swapped binary alters the hash', () => {
  const r = repo();
  r.write('a.txt', 'x\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  r.write('asset.wasm', Buffer.from([0, 1, 2, 3, 0]));
  r.commit('add');
  const before = changeSet('main', 'HEAD', r.dir).hash;
  r.write('asset.wasm', Buffer.from([0, 9, 9, 9, 0]));
  r.commit('swap');
  assert.notEqual(changeSet('main', 'HEAD', r.dir).hash, before);
});

test('a clean rebase keeps the hash; a change to a touched file voids it', () => {
  const r = repo();
  r.write('a.js', 'a\n');
  r.write('b.js', 'b\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  r.write('a.js', 'a2\n');
  r.commit('change');
  const before = changeSet('main', 'feat', r.dir).hash;

  r.run('checkout', '-q', 'main');
  r.write('b.js', 'b2\n');
  r.commit('unrelated');
  r.run('checkout', '-q', 'feat');
  r.run('rebase', '-q', 'main');
  assert.equal(changeSet('main', 'feat', r.dir).hash, before, 'unrelated base change keeps the hash');

  r.run('checkout', '-q', 'main');
  r.write('a.js', 'a\nmore\n');
  r.commit('touches the same file');
  r.run('checkout', '-q', 'feat');
  r.run('merge', '-q', '--no-edit', '-X', 'ours', 'main');
  assert.notEqual(changeSet('main', 'feat', r.dir).hash, before, 'a resolved conflict voids it');
});

test('merging base into the branch keeps the hash when nothing overlaps', () => {
  const r = repo();
  r.write('a.js', 'a\n');
  r.write('b.js', 'b\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  r.write('a.js', 'a2\n');
  r.commit('change');
  const before = changeSet('main', 'feat', r.dir).hash;
  r.run('checkout', '-q', 'main');
  r.write('b.js', 'b2\n');
  r.commit('unrelated');
  r.run('checkout', '-q', 'feat');
  r.run('merge', '-q', '--no-edit', 'main');
  assert.equal(changeSet('main', 'feat', r.dir).hash, before);
});

test('the hash ignores local diff configuration', () => {
  const r = repo();
  r.write('a.js', 'a\nb\nc\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  r.write('a.js', 'a\nx\nc\nd\n');
  r.write('z.js', 'z\n');
  r.commit('change');
  const before = changeSet('main', 'feat', r.dir).hash;
  writeFileSync(join(r.dir, '.git', 'order'), 'z.js\na.js\n');
  for (const [key, value] of [
    ['diff.algorithm', 'histogram'],
    ['diff.renames', 'copies'],
    ['diff.noprefix', 'true'],
    ['core.quotepath', 'false'],
    ['diff.orderFile', join(r.dir, '.git', 'order')],
    ['core.autocrlf', 'true'],
  ]) {
    r.run('config', key, value);
    assert.equal(changeSet('main', 'feat', r.dir).hash, before, key);
  }
});

test('a move reports both paths, so a workflow moved into docs/ hits the floor', () => {
  const r = repo();
  mkdirSync(join(r.dir, '.github/workflows'), { recursive: true });
  mkdirSync(join(r.dir, 'docs'), { recursive: true });
  r.write('.github/workflows/ci.yml', 'name: ci\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'feat');
  renameSync(join(r.dir, '.github/workflows/ci.yml'), join(r.dir, 'docs/ci.md'));
  r.commit('move');
  const paths = changeSet('main', 'feat', r.dir).changes.map((c) => c.path);
  assert.deepEqual(paths.sort(), ['.github/workflows/ci.yml', 'docs/ci.md']);
});

test('package.json scripts changes are detected; dependency bumps are not', () => {
  const r = repo();
  r.write('package.json', JSON.stringify({ scripts: { test: 'node t.js' }, dependencies: { a: '1' } }));
  r.commit('base');
  r.run('checkout', '-q', '-b', 'deps');
  r.write('package.json', JSON.stringify({ scripts: { test: 'node t.js' }, dependencies: { a: '2' } }));
  r.commit('bump');
  let set = changeSet('main', 'deps', r.dir);
  assert.deepEqual(scriptsChanged(set.changes, set.mergeBase, 'deps', r.dir), []);

  r.run('checkout', '-q', '-b', 'scripts', 'main');
  r.write('package.json', JSON.stringify({ scripts: { test: 'true' }, dependencies: { a: '1' } }));
  r.commit('neuter tests');
  set = changeSet('main', 'scripts', r.dir);
  assert.deepEqual(scriptsChanged(set.changes, set.mergeBase, 'scripts', r.dir), ['package.json']);
});

function revertFixture() {
  const r = repo();
  r.write('a.js', 'a\n');
  r.commit('base');
  r.write('a.js', 'bad\n');
  r.write('new.js', 'added\n');
  const merged = r.commit('Add a bad change');
  return { r, merged };
}

const check = (r, merged) => {
  const { changes } = changeSet('main', 'HEAD', r.dir);
  return verifyCleanRevert({ claimed: merged, changes, baseRef: 'main', config, cwd: r.dir });
};

test('claimedRevert reads the trailer', () => {
  assert.equal(claimedRevert('Why\n\nRevert-of: abc1234\n'), 'abc1234');
  assert.equal(claimedRevert('See Revert-of: abc1234 for why'), null);
});

test('a true inverse is a clean revert', () => {
  const { r, merged } = revertFixture();
  r.run('checkout', '-q', '-b', 'undo');
  r.run('revert', '--no-edit', merged);
  assert.deepEqual(check(r, merged), { ok: true, commit: merged });
});

test('a revert with extra changes is not clean', () => {
  const { r, merged } = revertFixture();
  r.run('checkout', '-q', '-b', 'undo');
  r.run('revert', '--no-edit', merged);
  r.write('sneaky.js', 'extra\n');
  r.commit('sneak');
  assert.equal(check(r, merged).ok, false);
});

test('a revert with different content on a reverted path is not clean', () => {
  const { r, merged } = revertFixture();
  r.run('checkout', '-q', '-b', 'undo');
  r.run('revert', '--no-edit', merged);
  r.write('a.js', 'something else\n');
  r.commit('tweak');
  assert.equal(check(r, merged).ok, false);
});

test('a revert of a revert gets no fast path, or it could re-land bad code', () => {
  const { r, merged } = revertFixture();
  r.run('revert', '--no-edit', merged);
  const reverted = r.run('rev-parse', 'HEAD').trim();
  r.run('checkout', '-q', '-b', 'redo');
  r.run('revert', '--no-edit', reverted);
  const result = check(r, reverted);
  assert.equal(result.ok, false);
  assert.match(result.reason, /itself a revert/);
});

test('reverting a commit that touched a protected path gets no fast path', () => {
  const r = repo();
  r.write('a.js', 'a\n');
  r.commit('base');
  r.write('pipeline.config.json', '{"weakened":true}\n');
  const merged = r.commit('Change policy');
  r.run('checkout', '-q', '-b', 'undo');
  r.run('revert', '--no-edit', merged);
  const result = check(r, merged);
  assert.equal(result.ok, false);
  assert.match(result.reason, /protected path/);
});

test('a commit not on the base branch cannot be claimed', () => {
  const r = repo();
  r.write('a.js', 'a\n');
  r.commit('base');
  r.run('checkout', '-q', '-b', 'side');
  r.write('a.js', 'side\n');
  const side = r.commit('side change');
  r.run('checkout', '-q', '-b', 'undo');
  r.run('revert', '--no-edit', side);
  const result = verifyCleanRevert({
    claimed: side,
    changes: changeSet('main', 'HEAD', r.dir).changes,
    baseRef: 'main',
    config,
    cwd: r.dir,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not on the base branch/);
});

test('git plumbing works under a path with spaces', () => {
  const r = repo();
  assert.match(r.dir, / /);
  assert.equal(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: r.dir, encoding: 'utf8' }).trim(), 'true');
});
