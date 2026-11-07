import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVerdict,
  budgetFor,
  emptyLedger,
  nextStep,
  recordRound,
  resolveFinding,
  sameFinding,
  selectSeats,
} from '../template/.pipeline/lib/ledger.mjs';

const council = { maxRounds: 3, maxRoundsSensitive: 5, maxNits: 5, maxSeats: 6, maxDiffGrowth: 1.5 };
const step = (ledger, overrides = {}) =>
  nextStep({ ledger, tier: 1, hash: 'h1', council, cleanTree: true, evidenceOk: true, diffLines: 100, ...overrides });

let serial = 0;
const finding = (severity, overrides = {}) => {
  serial += 1;
  return {
    severity,
    class: 'off-by-one',
    file: `src/file${serial}.js`,
    line: 1,
    claim: `claim ${serial}`,
    evidence: 'e',
    fix: 'f',
    preExisting: false,
    ...overrides,
  };
};

function round(ledger, hash, findings = [], extra = {}) {
  const planned = step(ledger, { hash });
  return recordRound(ledger, {
    mode: planned.mode ?? 'full',
    round: planned.round ?? 1,
    hash,
    sha: 'sha',
    diffLines: 100,
    result: { findings, seats: ['council-bug-hunter'], missing: [], maxNits: 5, ...extra },
  });
}

test('budgets: 1 round for T0, 3 for T1, 5 for T2', () => {
  assert.equal(budgetFor(0, council), 1);
  assert.equal(budgetFor(1, council), 3);
  assert.equal(budgetFor(2, council), 5);
});

test('a dirty tree and missing evidence come first', () => {
  assert.equal(step(emptyLedger(), { cleanTree: false }).status, 'commit-first');
  assert.equal(step(emptyLedger(), { evidenceOk: false }).status, 'prove-first');
});

test('the first round is a full review', () => {
  const next = step(emptyLedger());
  assert.equal(next.status, 'review');
  assert.equal(next.mode, 'full');
  assert.equal(next.round, 1);
});

test('a clean round on the same content is done, and renders a passing verdict', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1');
  assert.equal(step(ledger).status, 'done');
  const verdict = buildVerdict({ ledger, tier: 1, hash: 'h1' });
  assert.equal(verdict.changeHash, 'h1');
  assert.deepEqual([verdict.open.blocker, verdict.open.should], [0, 0]);
  assert.equal(verdict.rounds, 1);
});

test('open findings must be answered before anything else', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should')]);
  const next = step(ledger);
  assert.equal(next.status, 'answer-findings');
  assert.equal(next.open.length, 1);
  assert.throws(() => buildVerdict({ ledger, tier: 1, hash: 'h1' }), /Open findings/);
});

test('declining a finding needs a written reason', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should')]);
  const [{ id }] = ledger.findings;
  assert.throws(() => resolveFinding(ledger, id, 'wrong'), /written reason/);
  resolveFinding(ledger, id, 'wrong', 'The caller guards this at file.js:3');
  assert.equal(step(ledger).status, 'done');
});

test('nits are declined by default and never trigger another round', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('nit'), finding('nit')]);
  assert.equal(step(ledger).status, 'done');
  assert.equal(ledger.findings.every((f) => f.status === 'declined'), true);
});

test('nits are capped', () => {
  const ledger = emptyLedger();
  const outcome = round(ledger, 'h1', Array.from({ length: 8 }, () => finding('nit')));
  assert.equal(ledger.findings.length, 5);
  assert.equal(outcome.droppedNits.length, 3);
});

test('pre-existing bugs never block', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('blocker', { preExisting: true })]);
  assert.equal(step(ledger).status, 'done');
});

test('a repeated finding is dropped, even after being declined', () => {
  const ledger = emptyLedger();
  const repeat = finding('should', { claim: 'same claim' });
  round(ledger, 'h1', [repeat]);
  resolveFinding(ledger, ledger.findings[0].id, 'wrong', 'It is not');
  const outcome = recordRound(ledger, {
    mode: 'diff',
    round: 2,
    hash: 'h2',
    sha: 's',
    diffLines: 100,
    result: { findings: [{ ...repeat }], seats: [], missing: [] },
  });
  assert.equal(outcome.repeats.length, 1);
  assert.equal(ledger.findings.length, 1);
});

test('a reworded repeat on a shifted line is still a repeat', () => {
  const first = {
    file: 'src/users.js',
    line: 2,
    class: 'sql-injection (string-concatenated query)',
    claim: 'The name is concatenated into the SQL string.',
  };
  const second = {
    file: 'src/users.js',
    line: 4,
    class: 'SQL injection (untrusted input)',
    claim: 'User input reaches the query unescaped.',
  };
  assert.equal(sameFinding(first, second), true);
  assert.equal(sameFinding(first, { ...second, file: 'src/other.js' }), false, 'another file');
  assert.equal(sameFinding(first, { ...second, line: 40 }), false, 'far away');
  assert.equal(
    sameFinding(first, { ...second, class: 'race condition', claim: 'Two writers can interleave here.' }),
    false,
    'a different subject in the same place',
  );
});

test('after a fix, the next round is diff-only', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should')]);
  resolveFinding(ledger, ledger.findings[0].id, 'fixed');
  const next = step(ledger, { hash: 'h2' });
  assert.equal(next.status, 'review');
  assert.equal(next.mode, 'diff');
  assert.equal(next.round, 2);
});

test('an incomplete round does not count as approval and is rerun', () => {
  const ledger = emptyLedger();
  const outcome = round(ledger, 'h1', [], { missing: ['council-security-auditor'] });
  assert.equal(outcome.complete, false);
  const next = step(ledger);
  assert.equal(next.status, 'review');
  assert.throws(() => buildVerdict({ ledger, tier: 1, hash: 'h1' }), /incomplete/);
});

function fixAll(ledger) {
  for (const f of ledger.findings) if (f.status === 'open') resolveFinding(ledger, f.id, 'fixed');
}

test('convergence: the loop always terminates, and a 50-round runaway is impossible', () => {
  // An agent author and a reviewer that always finds one more bug.
  const ledger = emptyLedger();
  const history = [];
  let hash = 0;
  for (let i = 0; i < 60; i += 1) {
    hash += 1;
    const next = step(ledger, { hash: `h${hash}` });
    history.push(next.status + (next.mode ? `:${next.mode}` : ''));
    if (next.status === 'parked') break;
    if (next.status === 'step-back') {
      ledger.steppedBack = true;
      continue;
    }
    recordRound(ledger, {
      mode: next.mode,
      round: next.round,
      hash: `h${hash}`,
      sha: 's',
      diffLines: 100,
      result: { findings: [finding('should')], seats: [], missing: [] },
    });
    fixAll(ledger);
  }
  assert.deepEqual(history, [
    'review:full',
    'review:diff',
    'review:diff',
    'review:confirm',
    'step-back',
    'review:full',
    'parked',
  ]);
  assert.ok(ledger.rounds.length <= 5, `ran ${ledger.rounds.length} rounds`);
});

test('a good fix in the final round reaches done through the free confirmation', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should')]);
  fixAll(ledger);
  round(ledger, 'h2', [finding('should')]);
  fixAll(ledger);
  round(ledger, 'h3', [finding('should')]);
  fixAll(ledger);
  const next = step(ledger, { hash: 'h4' });
  assert.equal(next.mode, 'confirm');
  recordRound(ledger, { mode: 'confirm', round: next.round, hash: 'h4', sha: 's', diffLines: 100, result: { findings: [], seats: [], missing: [] } });
  assert.equal(step(ledger, { hash: 'h4' }).status, 'done');
  assert.equal(buildVerdict({ ledger, tier: 1, hash: 'h4' }).rounds, 3, 'the confirmation does not count');
});

test('T0 gets a single round', () => {
  const ledger = emptyLedger();
  recordRound(ledger, { mode: 'full', round: 1, hash: 'h1', sha: 's', diffLines: 5, result: { findings: [finding('should')], seats: [], missing: [] } });
  fixAll(ledger);
  assert.equal(step(ledger, { tier: 0, hash: 'h2', diffLines: 5 }).mode, 'confirm');
});

test('a diff that balloons during review must be cut first', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should')]);
  fixAll(ledger);
  assert.equal(step(ledger, { hash: 'h2', diffLines: 120 }).status, 'review', 'modest growth is fine');
  assert.equal(step(ledger, { hash: 'h2', diffLines: 2000 }).status, 'cut-first');
  ledger.growthAccepted = 'The fix genuinely needed a new module';
  assert.equal(step(ledger, { hash: 'h2', diffLines: 2000 }).status, 'review');
});

test('a verdict for other content is refused', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1');
  assert.throws(() => buildVerdict({ ledger, tier: 1, hash: 'h2' }), /different content/);
});

test('a raise reaches the verdict and lifts its tier', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should', { raise: { class: 'legal', reason: 'GPL dependency' } })]);
  resolveFinding(ledger, ledger.findings[0].id, 'deferred', 'Waiting on the decision');
  const verdict = buildVerdict({ ledger, tier: 1, hash: 'h1' });
  assert.equal(verdict.tier, 2);
  assert.equal(verdict.raise.class, 'legal');
});

test('the verdict carries dispositions for metrics', () => {
  const ledger = emptyLedger();
  round(ledger, 'h1', [finding('should'), finding('nit')]);
  resolveFinding(ledger, ledger.findings.find((f) => f.severity === 'should').id, 'intentional', 'By design');
  const verdict = buildVerdict({ ledger, tier: 1, hash: 'h1' });
  assert.deepEqual(verdict.findings.map((f) => f.disposition).sort(), ['deferred', 'intentional']);
});

const seats = (input) => selectSeats({ council, ...input }).seats.map((s) => s.agent.replace('council-', ''));

test('T0 uses two Sonnet seats and one voter', () => {
  const selection = selectSeats({ tier: 0, paths: ['docs/a.md'], council });
  assert.deepEqual(selection.seats.map((s) => s.model), ['sonnet', 'sonnet']);
  assert.deepEqual(selection.panel, ['sonnet']);
});

test('T1 has four core seats, plus what the paths call for', () => {
  assert.deepEqual(seats({ tier: 1, paths: ['tests/a.test.js'] }), ['bug-hunter', 'minimalist', 'security-auditor', 'evidence-auditor']);
  assert.ok(seats({ tier: 1, paths: ['src/a.js'] }).includes('reliability-engineer'));
  assert.ok(seats({ tier: 1, paths: ['src/a.tsx'] }).includes('ux-a11y-reviewer'));
  assert.ok(seats({ tier: 1, paths: ['package.json'] }).includes('legal-reviewer'));
  assert.ok(seats({ tier: 1, paths: ['src/a.js'], diffLines: 900 }).includes('architect'));
});

test('T2 always has the architect, and a three-voter panel with Opus', () => {
  const selection = selectSeats({ tier: 2, paths: ['.pipeline/gate.mjs'], council });
  assert.ok(selection.seats.some((s) => s.agent === 'council-architect'));
  assert.deepEqual(selection.panel, ['sonnet', 'sonnet', 'opus']);
});

test('the seat cap drops seats in order, and never security or architect on T2', () => {
  const selection = selectSeats({ tier: 2, paths: ['src/app.tsx', 'package.json', 'src/auth/x.ts'], council });
  const names = selection.seats.map((s) => s.agent);
  assert.equal(names.length, 6);
  assert.deepEqual(selection.dropped, ['council-ux-a11y-reviewer', 'council-reliability-engineer']);
  assert.ok(names.includes('council-security-auditor'));
  assert.ok(names.includes('council-architect'));
  assert.ok(selection.seats.length + selection.panel.length <= 9, 'stays within the agent limit');
});
