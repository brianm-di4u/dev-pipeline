// Drives the real council.mjs and verify.mjs in a scaffolded repo, through to a verdict
// the real gate accepts. The seats are faked: this tests the wiring, not the models.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { scaffold } from '../bin/pipeline.mjs';

const parent = mkdtempSync(join(tmpdir(), 'council cli '));
const dir = join(parent, 'proj');
const remote = join(parent, 'remote.git');

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }).trim();
const council = (...args) => spawnSync('node', ['.pipeline/council.mjs', ...args], { cwd: dir, env, encoding: 'utf8' });
const plan = (...args) => {
  const result = council('plan', ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const verify = () => spawnSync('node', ['.pipeline/verify.mjs', 'full'], { cwd: dir, env, encoding: 'utf8' });
const commit = (message) => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
};
const record = (result) => {
  const path = join(parent, 'result.json');
  writeFileSync(path, JSON.stringify(result));
  const output = council('record', path);
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
};

before(() => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  scaffold(dir, { pack: 'generic', admin: 'owner', project: 'proj' });
  const configPath = join(dir, 'pipeline.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const level of ['fast', 'full', 'e2e']) config.verify[level] = 'node --version';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'app.js'), 'export const a = 1;\n');
  git('init', '-q', '-b', 'main');
  commit('Base');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'app.js'), 'export const a = 2;\n');
});

after(() => rmSync(parent, { recursive: true, force: true }));

test('the whole loop, from a dirty tree to a verdict the gate accepts', async () => {
  // A dirty tree, then no evidence, then no intent: each one comes first.
  assert.equal(plan().status, 'commit-first');
  commit('Change a');
  assert.equal(plan().status, 'prove-first');
  assert.equal(verify().status, 0);
  assert.equal(plan().status, 'needs-intent');

  // Round 1: a full review of an ordinary change.
  const first = plan('--intent', 'Change a to 2');
  assert.equal(first.status, 'review');
  assert.equal(first.mode, 'full');
  assert.equal(first.tier, 1);
  assert.ok(first.seats.some((s) => s.agent === 'council-bug-hunter'));
  assert.ok(first.evidenceDir.includes('.pipeline/evidence'));

  // A seat that never answered means the round doesn't count.
  let recorded = record({ findings: [], seats: ['council-bug-hunter'], missing: ['council-security-auditor'] });
  assert.equal(recorded.complete, false);
  assert.equal(plan().mode, 'full');
  assert.notEqual(council('verdict').status, 0);

  // A real finding has to be answered.
  recorded = record({
    findings: [{ severity: 'should', class: 'wrong value', file: 'app.js', line: 1, claim: 'Should be 3.', fix: 'Use 3.' }],
    seats: ['council-bug-hunter'],
    missing: [],
  });
  const [{ id }] = recorded.answerThese;
  assert.equal(plan().status, 'answer-findings');
  assert.notEqual(council('verdict').status, 0, 'no verdict with an open finding');
  assert.notEqual(council('resolve', id, 'wrong').status, 0, 'declining needs a reason');
  assert.equal(council('resolve', id, 'fixed').status, 0);

  // Fix it, prove it again, and the next round is diff-only.
  writeFileSync(join(dir, 'app.js'), 'export const a = 3;\n');
  commit('Fix a');
  assert.equal(plan().status, 'prove-first', 'the old evidence no longer matches');
  assert.equal(verify().status, 0);
  const second = plan();
  assert.equal(second.mode, 'diff');
  assert.equal(second.round, 2);
  assert.ok(second.lastReviewedSha);
  assert.equal(second.intent, 'Change a to 2', 'the intent carries over');

  // A clean round on this exact content is done, and the verdict matches the change.
  record({ findings: [], seats: ['council-bug-hunter'], missing: [] });
  assert.equal(plan().status, 'done');
  const verdict = council('verdict');
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.match(verdict.stdout, /pipeline:verdict/);

  const { parseVerdict } = await import('../template/.pipeline/lib/contract.mjs');
  const { evaluateGate } = await import('../template/.pipeline/lib/gate-core.mjs');
  const { changeSet } = await import('../template/.pipeline/lib/git.mjs');
  const parsed = parseVerdict(verdict.stdout).verdict;
  const set = changeSet('origin/main', 'HEAD', dir);
  assert.equal(parsed.changeHash, set.hash);
  assert.equal(parsed.rounds, 2);
  const config = JSON.parse(readFileSync(join(dir, 'pipeline.config.json'), 'utf8'));
  const result = evaluateGate({
    pr: {
      author: 'owner',
      draft: false,
      base: 'main',
      body: `## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert it.\n\n${verdict.stdout}`,
    },
    changes: set.changes,
    hash: set.hash,
    config,
    verify: 'success',
  });
  assert.equal(result.conclusion, 'success', result.summary);

  // Any further content change voids it.
  appendFileSync(join(dir, 'app.js'), '// a comment\n');
  commit('Touch it');
  assert.notEqual(council('verdict').status, 0, 'the verdict refuses changed content');
});

test('a round is refused if HEAD moved while it ran, or the checkout was left detached', () => {
  git('checkout', '-q', '-b', 'moved', 'main');
  writeFileSync(join(dir, 'moved.js'), 'export const m = 1;\n');
  commit('Moved');
  assert.equal(verify().status, 0);
  assert.equal(plan('--intent', 'Add m').status, 'review');

  writeFileSync(join(dir, 'moved.js'), 'export const m = 2;\n');
  commit('Someone moved HEAD');
  const path = join(parent, 'late.json');
  writeFileSync(path, JSON.stringify({ findings: [], seats: [], missing: [] }));
  const refused = council('record', path);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /HEAD moved/);

  git('checkout', '-q', '--detach');
  const detached = council('plan');
  assert.notEqual(detached.status, 0);
  assert.match(detached.stderr, /detached/);
  git('checkout', '-q', 'moved');
});

test('a protected path plans as T2, with the architect and an Opus voter', () => {
  git('checkout', '-q', '-b', 'protected', 'main');
  writeFileSync(join(dir, '.pipeline', 'note.md'), 'note\n');
  commit('Protected');
  assert.equal(verify().status, 0);
  const next = plan('--intent', 'Add a note');
  assert.equal(next.tier, 2);
  assert.equal(next.budget, 5);
  assert.ok(next.seats.some((s) => s.agent === 'council-architect'));
  assert.ok(next.panel.includes('opus'));
});

test('after a rebase, a diff round starts from the rebased copy of what was reviewed', () => {
  git('checkout', '-q', '-b', 'rebased', 'main');
  writeFileSync(join(dir, 'r.js'), 'export const r = 1;\n');
  commit('Add r');
  assert.equal(verify().status, 0);
  assert.equal(plan('--intent', 'Add r').status, 'review');
  const recorded = record({
    findings: [{ severity: 'should', class: 'wrong value', file: 'r.js', line: 1, claim: 'Should be 2.', fix: 'Use 2.' }],
    seats: ['council-bug-hunter'],
    missing: [],
  });
  assert.equal(council('resolve', recorded.answerThese[0].id, 'fixed').status, 0);
  const reviewed = git('rev-parse', 'HEAD');

  // Main moves on, the branch is rebased, and then the fix lands.
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'elsewhere.js'), 'export const e = 1;\n');
  commit('Someone else');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'rebased');
  git('rebase', '-q', 'main');
  const rebasedCopy = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'r.js'), 'export const r = 2;\n');
  commit('Fix r');
  assert.equal(verify().status, 0);

  const next = plan();
  assert.equal(next.mode, 'diff');
  assert.notEqual(next.lastReviewedSha, reviewed, 'the pre-rebase commit would pull in main');
  assert.equal(next.lastReviewedSha, rebasedCopy);
});

test('--decision takes an issue number', () => {
  const bad = council('plan', '--decision', 'soon');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /issue number/);
});

test('inline personas carry the same prompts and models', () => {
  const next = plan('--inline-personas');
  assert.equal(next.personas['council-security-auditor'].model, 'opus');
  assert.match(next.personas['council-bug-hunter'].body, /bug hunter/);
});
