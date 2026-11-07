// Runs the real council-round workflow against fake agents. The most dangerous bug
// found while building this was a verifier that couldn't see the code "refuting"
// everything, which turned a broken setup into a clean pass. These tests pin down that
// a review which didn't really happen can never look like one that found nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../template/.claude/workflows/council-round.js', import.meta.url), 'utf8');
const body = source.replace(/export const meta = \{[\s\S]*?\n\}\n/, '');
const AsyncFunction = (async () => {}).constructor;
const round = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body);

const parallel = async (thunks) =>
  Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));

const finding = (overrides = {}) => ({
  severity: 'blocker',
  class: 'off-by-one',
  file: 'src/a.js',
  line: 2,
  claim: 'Wrong.',
  evidence: 'Ran it.',
  fix: 'Fix it.',
  preExisting: false,
  ...overrides,
});

const plan = (overrides = {}) => ({
  mode: 'full',
  tier: 1,
  intent: 'Do a thing',
  mergeBase: 'base',
  head: 'head',
  evidenceDir: '/evidence',
  seats: [{ agent: 'council-bug-hunter' }, { agent: 'council-minimalist' }],
  panel: ['sonnet', 'sonnet'],
  openFindings: [],
  ...overrides,
});

// seats: seat name -> result. voters: an array of ballots, used in order.
function run(args, { seats = {}, voters = [], confirm = null } = {}) {
  const calls = [];
  let voter = 0;
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    if (options.label === 'confirm') return confirm;
    if (options.label?.startsWith('verifier')) return voters[voter++] ?? null;
    return seats[options.agentType] ?? { headVisible: true, summary: 'ok', findings: [] };
  };
  return round(args, agent, parallel, () => {}, () => {}).then((result) => ({ result, calls }));
}

const vote = (...verdicts) => ({
  headVisible: true,
  votes: verdicts.map((verdict, key) => ({ key, verdict, reason: 'r' })),
});
const seen = (findings) => ({ headVisible: true, summary: 's', findings });

test('a clean round from seats that saw the change is complete', async () => {
  const { result, calls } = await run(plan());
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.missing, []);
  assert.equal(calls.length, 2, 'no verifiers without candidates');
});

test('a seat that could not see the change does not count, even with an empty list', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': { headVisible: false, summary: 'no such commit', findings: [] } },
  });
  assert.deepEqual(result.missing, ['council-bug-hunter']);
  assert.deepEqual(result.seats, ['council-minimalist']);
});

test('a seat that errored does not count', async () => {
  const agent = async (prompt, options) => {
    if (options.agentType === 'council-bug-hunter') throw new Error('agent type not found');
    return seen([]);
  };
  const result = await round(plan(), agent, parallel, () => {}, () => {});
  assert.deepEqual(result.missing, ['council-bug-hunter']);
});

test('verifiers that cannot see the code never make a bug disappear', async () => {
  // This is the exact failure: seats find it, verifiers are in the wrong folder.
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [{ headVisible: false, votes: [] }, { headVisible: false, votes: [] }],
  });
  assert.ok(result.missing.includes('council-verifier'), 'the round must not count');
  assert.equal(result.refuted, 0);
  assert.equal(result.findings.length, 1, 'the bug is not dropped');
});

test('a cannot-check vote makes the round incomplete, and keeps the finding', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('cannot-check'), vote('cannot-check')],
  });
  assert.ok(result.missing.includes('council-verifier'));
  assert.equal(result.findings.length, 1);
  assert.equal(result.refuted, 0);
});

test('a verifier that skips a finding makes the round incomplete', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [{ headVisible: true, votes: [] }, vote('real')],
  });
  assert.ok(result.missing.includes('council-verifier'));
  assert.equal(result.findings.length, 1);
});

test('a missing verifier makes the round incomplete', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('refuted')],
  });
  assert.ok(result.missing.includes('council-verifier'));
  assert.equal(result.refuted, 0, 'one vote of two is not a majority');
  assert.equal(result.findings.length, 1);
});

test('a majority of a complete panel can refute a finding', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('refuted'), vote('refuted')],
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.findings, []);
  assert.equal(result.refuted, 1);
});

test('a split panel keeps the finding', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('refuted'), vote('real')],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'blocker');
});

test('three voters: two refutations drop it; one does not', async () => {
  const panel = ['sonnet', 'sonnet', 'opus'];
  const seats = { 'council-bug-hunter': seen([finding()]) };
  let { result } = await run(plan({ panel }), { seats, voters: [vote('refuted'), vote('refuted'), vote('real')] });
  assert.deepEqual(result.findings, []);
  ({ result } = await run(plan({ panel }), { seats, voters: [vote('refuted'), vote('real'), vote('real')] }));
  assert.equal(result.findings.length, 1);
});

test('downgraded votes turn a finding into a nit', async () => {
  const { result } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('downgraded'), vote('downgraded')],
  });
  assert.equal(result.findings[0].severity, 'nit');
});

test('seats reporting one place in different words become one finding, at the highest severity', async () => {
  const { result } = await run(plan(), {
    seats: {
      'council-bug-hunter': seen([finding({ severity: 'should', class: 'sql injection' })]),
      'council-minimalist': seen([finding({ severity: 'blocker', class: 'string-built query' })]),
    },
    voters: [vote('real'), vote('real')],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'blocker');
});

test('findings come back ranked by severity', async () => {
  const { result } = await run(plan(), {
    seats: {
      'council-bug-hunter': seen([
        finding({ severity: 'nit', line: 1 }),
        finding({ severity: 'blocker', line: 2 }),
        finding({ severity: 'should', line: 3 }),
      ]),
    },
    voters: [vote('real', 'real', 'real'), vote('real', 'real', 'real')],
  });
  assert.deepEqual(result.findings.map((f) => f.severity), ['blocker', 'should', 'nit']);
});

test('a confirmation pass that cannot see the fix does not count', async () => {
  const { result } = await run(plan({ mode: 'confirm', seats: [], lastReviewedSha: 'old' }), {
    confirm: { headVisible: false, summary: 'no', findings: [] },
  });
  assert.ok(result.missing.includes('council-verifier'));
});

test('a confirmation pass that errors does not count', async () => {
  const { result } = await run(plan({ mode: 'confirm', seats: [], lastReviewedSha: 'old' }), { confirm: null });
  assert.ok(result.missing.includes('council-verifier'));
});

test('every reviewer is told to prove it can see the change', async () => {
  const { calls } = await run(plan(), {
    seats: { 'council-bug-hunter': seen([finding()]) },
    voters: [vote('real'), vote('real')],
  });
  for (const call of calls) assert.match(call.prompt, /git cat-file -e head/, call.options.label);
});

test('later rounds only look at what changed, and carry the open findings', async () => {
  const { calls } = await run(plan({ mode: 'diff', lastReviewedSha: 'old', openFindings: [{ id: 'S1' }] }));
  assert.match(calls[0].prompt, /git diff old head/);
  assert.match(calls[0].prompt, /S1/);
});

test('reviewers read the rules from the base branch, never from the change', async () => {
  const { calls } = await run(plan());
  assert.match(calls[0].prompt, /git show base:REVIEW\.md/);
});

test('by default reviewers get disposable worktrees; a set location pins them', async () => {
  let { calls } = await run(plan());
  assert.equal(calls[0].options.isolation, 'worktree');
  ({ calls } = await run(plan({ cwd: '/case' })));
  assert.equal(calls[0].options.isolation, undefined);
  assert.match(calls[0].prompt, /\/case/);
});

test('registered seats are used by name; inline personas carry the same prompt and model', async () => {
  let { calls } = await run(plan());
  assert.equal(calls[0].options.agentType, 'council-bug-hunter');
  const personas = { 'council-bug-hunter': { body: 'You are the bug hunter.', model: 'opus', effort: 'high' }, 'council-minimalist': { body: 'Min.', model: 'sonnet' } };
  ({ calls } = await run(plan({ personas })));
  assert.equal(calls[0].options.agentType, undefined);
  assert.equal(calls[0].options.model, 'opus');
  assert.equal(calls[0].options.effort, 'high');
  assert.match(calls[0].prompt, /^You are the bug hunter/);
});
