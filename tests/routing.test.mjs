// Delegate approvers, PR 7: who can start work, pr-wait's trust, and which model
// a worker runs on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as before from './fixtures/before-delegates/queue.mjs';
import { parseConfig } from '../template/.pipeline/lib/config.mjs';
import { buildVerdict, emptyLedger, recordRound } from '../template/.pipeline/lib/ledger.mjs';
import { eligible, nextAction, pickNext, workerModel } from '../template/.pipeline/lib/queue.mjs';

const config = { admins: ['owner'], autopilot: { maxPrsPerDay: 5, maxConsecutiveFailures: 2 } };
const now = new Date('2026-11-10T12:00:00Z');
const issue = (number, labels = ['ready'], login = 'owner', extra = {}) => ({
  number,
  title: `Task ${number}`,
  state: 'open',
  user: { login },
  author_association: 'COLLABORATOR',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

const ISSUES = [
  issue(1),
  issue(2, ['ready'], 'stranger'),
  issue(3, ['ready'], 'gardener'),
  issue(4, ['ready', 'triage']),
  issue(5, ['ready', 'priority:high', 'complexity:high']),
  issue(6, ['ready', 'complexity:low']),
  issue(7, ['ready'], 'owner', { pull_request: {} }),
  issue(8, ['ready', 'decision-needed']),
];

test('without delegates or models, the queue picks exactly as before', () => {
  for (const one of ISSUES) {
    assert.equal(eligible(one, ['owner']), before.eligible(one, ['owner']), `#${one.number}`);
    assert.equal(eligible(one, config), before.eligible(one, ['owner']), `#${one.number} via config`);
  }
  for (let i = 0; i < ISSUES.length; i += 1) {
    const slice = ISSUES.slice(i);
    assert.equal(pickNext(slice, ['owner']), before.pickNext(slice, ['owner']));
  }
  const states = [
    {},
    { mainRed: true },
    { breakerTripped: true },
    { openOwnPrs: [12] },
    { run: { consecutiveFailures: 2 } },
    { merges: Array.from({ length: 5 }, (_, i) => ({ merged_at: '2026-11-10T06:00:00Z', number: i })) },
    { sourceError: 'HTTP 502' },
    { issues: [] },
  ];
  for (const state of states) {
    const input = { issues: ISSUES, config, mainRed: false, breakerTripped: false, merges: [], openOwnPrs: [], run: {}, now, ...state };
    assert.deepEqual(nextAction(input), before.nextAction(input), JSON.stringify(state));
  }
});

const delegated = (grant = {}) => ({ ...config, delegates: [{ login: 'gardener', approve: true, direct: true, ...grant }] });

test('a delegate with direct can start work; without it, it cannot', () => {
  assert.equal(eligible(issue(3, ['ready'], 'gardener'), delegated()), true);
  assert.equal(eligible(issue(3, ['ready'], 'Gardener'), delegated()), true);
  assert.equal(eligible(issue(3, ['ready'], 'gardener'), delegated({ direct: false })), false);
  assert.equal(eligible(issue(3, ['ready', 'triage'], 'gardener'), delegated()), false, 'the same filters apply');
  assert.equal(eligible(issue(2, ['ready'], 'stranger'), delegated()), false);
  assert.equal(nextAction({ issues: [issue(3, ['ready'], 'gardener')], config: delegated(), merges: [], openOwnPrs: [], run: {}, now }).issue.number, 3);
});

const models = { worker: 'sonnet', workerComplex: 'opus', workerSimple: 'haiku' };

test('the model comes from complexity labels, and a task a worker struggled with gets the stronger one', () => {
  assert.equal(workerModel(issue(1), models, {}), 'sonnet');
  assert.equal(workerModel(issue(5, ['ready', 'complexity:high']), models, {}), 'opus');
  assert.equal(workerModel(issue(6, ['ready', 'complexity:low']), models, {}), 'haiku');
  assert.equal(workerModel(issue(6, ['ready', 'complexity:low']), models, { history: [{ issue: '6', state: 'failed' }] }), 'opus');
  assert.equal(workerModel(issue(1), models, { history: [{ issue: 1, state: 'parked' }] }), 'opus');
  assert.equal(workerModel(issue(1), models, { history: [{ issue: 1, state: 'merged' }] }), 'sonnet');
  assert.equal(workerModel(issue(1), undefined, {}), null);
  assert.equal(workerModel(issue(5, ['complexity:high']), { worker: 'sonnet' }, {}), 'sonnet', 'falls back to the default worker');
});

test('a work action carries the model only when models are configured', () => {
  const base = { issues: [issue(5, ['ready', 'complexity:high'])], merges: [], openOwnPrs: [], run: {}, now };
  assert.equal('model' in nextAction({ ...base, config }), false);
  assert.equal(nextAction({ ...base, config: { ...config, models } }).model, 'opus');
});

const CONFIG_TEXT = (extra) =>
  JSON.stringify({ admins: ['owner'], tiers: {}, merge: {}, verify: {}, ...extra });

test('models config is validated only when present, and never thrown on', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal('models' in parseConfig(CONFIG_TEXT({}), { warn }), false);
  assert.deepEqual(parseConfig(CONFIG_TEXT({ models }), { warn }).models, models);
  assert.deepEqual(warnings, []);
  const mixed = parseConfig(CONFIG_TEXT({ models: { worker: 'sonnet', workerComplex: 5, boss: 'opus', workerSimple: 'claude-haiku-5-5[1m]' } }), { warn });
  assert.deepEqual(mixed.models, { worker: 'sonnet', workerSimple: 'claude-haiku-5-5[1m]' });
  assert.equal(warnings.length, 2);
  assert.equal(parseConfig(CONFIG_TEXT({ models: 'opus' }), { warn }).models, undefined);
});

test('the verdict records the worker model only when the council was told it', () => {
  const ledger = emptyLedger();
  recordRound(ledger, { mode: 'full', round: 1, hash: 'h1', sha: 's', diffLines: 10, result: { findings: [], seats: ['x'], missing: [], maxNits: 5 } });
  assert.equal('worker' in buildVerdict({ ledger, tier: 1, hash: 'h1' }), false);
  assert.deepEqual(buildVerdict({ ledger: { ...ledger, worker: 'sonnet' }, tier: 1, hash: 'h1' }).worker, { model: 'sonnet' });
});

// pr-wait is Python. Load it from a folder holding a config, and ask it.
const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

function askPrWait(cfg, logins) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify(cfg));
    const code = [
      'import importlib.machinery, importlib.util, json, sys',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'spec = importlib.util.spec_from_loader("prwait", loader)',
      'mod = importlib.util.module_from_spec(spec)',
      'loader.exec_module(mod)',
      // A comment as pr-wait reads it: GitHub's access field on it, as a collaborator's has.
      'node = lambda l: {"author": {"login": l}, "authorAssociation": "COLLABORATOR"}',
      `print(json.dumps({l: [mod.trusted(node(l)), mod.is_delegate(node(l))] for l in ${JSON.stringify(logins)}}))`,
    ].join('\n');
    const run = spawnSync(python, ['-c', code], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pr-wait trusts admins only, without delegates', { skip: !python && 'python not installed' }, () => {
  assert.deepEqual(askPrWait({ admins: ['owner'] }, ['owner', 'Owner', 'gardener']), {
    owner: [true, false],
    Owner: [false, false],
    gardener: [false, false],
  });
});

test('pr-wait trusts a delegate with direct, and names any delegate\'s commands', { skip: !python && 'python not installed' }, () => {
  const cfg = {
    admins: ['owner'],
    delegates: [
      { login: 'Gardener', approve: true, direct: true },
      { login: 'helper', approve: true },
      { login: 'owner', direct: true },
      { login: 'broken', direct: 'yes' },
    ],
  };
  assert.deepEqual(askPrWait(cfg, ['gardener', 'helper', 'broken', 'stranger']), {
    gardener: [true, true],
    helper: [false, true],
    broken: [false, false],
    stranger: [false, false],
  });
});
