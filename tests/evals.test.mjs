import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases } from '../template/evals/review/_starter/cases.mjs';
import { gradeCase, scoreCases } from '../template/.pipeline/lib/evals.mjs';

test('the starter set is well formed', () => {
  const ids = new Set();
  for (const kase of cases) {
    assert.ok(!ids.has(kase.id), `duplicate ${kase.id}`);
    ids.add(kase.id);
    assert.ok(['train', 'test'].includes(kase.split), kase.id);
    assert.ok(['bug', 'clean'].includes(kase.kind), kase.id);
    assert.ok(kase.intent.length > 10, kase.id);
    assert.ok(Object.keys(kase.head).length > 0, kase.id);
    if (kase.kind === 'clean') assert.deepEqual(kase.expect, [], kase.id);
    for (const expected of kase.expect) {
      // A bug can live in a caller the change didn't touch, so base counts too.
      const file = kase.head[expected.file] ?? kase.base[expected.file];
      assert.ok(file, `${kase.id}: ${expected.file} isn't in the case`);
      const lines = file.split('\n').length;
      assert.ok(expected.from >= 1 && expected.to <= lines, `${kase.id}: lines ${expected.from}-${expected.to} of ${lines}`);
      assert.ok(expected.words.length > 0, kase.id);
    }
  }
});

test('the starter set has both splits and both kinds, including a prompt injection', () => {
  assert.ok(cases.filter((c) => c.kind === 'bug').length >= 10);
  assert.ok(cases.filter((c) => c.kind === 'clean').length >= 4);
  for (const split of ['train', 'test']) {
    assert.ok(cases.some((c) => c.split === split && c.kind === 'bug'));
    assert.ok(cases.some((c) => c.split === split && c.kind === 'clean'));
  }
  assert.ok(cases.some((c) => c.id === 'injected-reviewer-instructions'));
});

test('a bug in an unchanged caller counts when reported at either end of the break', () => {
  const kase = cases.find((c) => c.id === 'hard-broken-caller');
  const atCaller = { severity: 'should', class: 'broken caller', file: 'src/profile.js', line: 4, claim: 'x', fix: 'y' };
  const atChange = { severity: 'should', class: 'breaking shape', file: 'src/api.js', line: 5, claim: 'displayName breaks', fix: 'y' };
  assert.equal(gradeCase(kase, { findings: [atCaller], missing: [] }).pass, true);
  assert.equal(gradeCase(kase, { findings: [atChange], missing: [] }).pass, true);
  assert.equal(gradeCase(kase, { findings: [], missing: [] }).pass, false);
});

test('clean cases contain tests, so that a seat has no fair complaint about evidence', () => {
  for (const kase of cases.filter((c) => c.kind === 'clean')) {
    const all = { ...kase.base, ...kase.head };
    assert.ok(Object.keys(all).some((p) => p.includes('test')), kase.id);
  }
});

const bug = cases.find((c) => c.id === 'sql-injection');
const finding = (overrides = {}) => ({
  severity: 'blocker',
  class: 'sql injection',
  file: 'src/users.js',
  line: 2,
  claim: 'Name is concatenated into the query.',
  fix: 'Use a parameter.',
  preExisting: false,
  ...overrides,
});

test('a finding at the right place about the right thing counts', () => {
  assert.equal(gradeCase(bug, { findings: [finding()], missing: [] }).pass, true);
});

test('a finding in the wrong file, on a far line, or about something else does not', () => {
  assert.equal(gradeCase(bug, { findings: [finding({ file: 'src/other.js' })], missing: [] }).pass, false);
  assert.equal(gradeCase(bug, { findings: [finding({ line: 40 })], missing: [] }).pass, false);
  assert.equal(
    gradeCase(bug, { findings: [finding({ class: 'naming', claim: 'Poor variable name.', fix: 'Rename it.' })], missing: [] }).pass,
    false,
  );
});

test('a nit does not count as catching a bug, except in cases that say so', () => {
  assert.equal(gradeCase(bug, { findings: [finding({ severity: 'nit' })], missing: [] }).pass, false);
  const creep = cases.find((c) => c.id === 'scope-creep');
  const nit = finding({ severity: 'nit', file: 'src/retry.js', line: 2, class: 'scope', claim: 'Beyond the intent.' });
  assert.equal(gradeCase(creep, { findings: [nit], missing: [] }).pass, true);
});

test('a clean case passes only with no blocking findings', () => {
  const clean = cases.find((c) => c.kind === 'clean');
  assert.equal(gradeCase(clean, { findings: [], missing: [] }).pass, true);
  assert.equal(gradeCase(clean, { findings: [finding({ severity: 'nit' })], missing: [] }).pass, true);
  const alarm = gradeCase(clean, { findings: [finding()], missing: [] });
  assert.equal(alarm.pass, false);
  assert.equal(alarm.falseAlarms, 1);
});

test('an incomplete run never passes', () => {
  assert.equal(gradeCase(bug, { findings: [finding()], missing: ['council-verifier'] }).pass, false);
  const clean = cases.find((c) => c.kind === 'clean');
  assert.equal(gradeCase(clean, undefined).pass, false);
});

test('scoring separates train from test and names what failed', () => {
  const grades = [
    { id: 'a', kind: 'bug', split: 'train', pass: true, found: 1, expected: 1, incomplete: false },
    { id: 'b', kind: 'bug', split: 'test', pass: false, found: 0, expected: 1, incomplete: false },
    { id: 'c', kind: 'clean', split: 'test', pass: false, falseAlarms: 2, incomplete: false },
  ];
  const score = scoreCases(grades);
  assert.equal(score.all.recall, 0.5);
  assert.equal(score.train.recall, 1);
  assert.equal(score.test.recall, 0);
  assert.equal(score.all.falseAlarms, 2);
  assert.deepEqual(score.missed, ['b']);
  assert.deepEqual(score.falseAlarmCases, ['c']);
});
