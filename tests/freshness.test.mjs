// Branch freshness: the gate lets a PR merge while behind main unless main
// changed something it depends on. Without `freshness`, nothing changes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluateGate as evaluateBefore } from './fixtures/before-freshness/gate-core.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { freshnessCheck, pushBranches, strictFrom } from '../bin/pipeline.mjs';
import { buildInbox } from '../template/.pipeline/garden.mjs';
import { evaluatingBody, freshAt, mainMoved, publishFresh, publishedSince } from '../template/.pipeline/gate.mjs';
import { parseConfig } from '../template/.pipeline/lib/config.mjs';
import { gateRunProblems } from '../template/.pipeline/lib/delegates.mjs';
import { buildDigest, freshnessSummary, renderDigest } from '../template/.pipeline/lib/digest.mjs';
import { FRESHNESS_FLOOR, STALE_MARKER, cleanFreshness, freshnessOf, isStaleSummary } from '../template/.pipeline/lib/freshness.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';
import { changeSet } from '../template/.pipeline/lib/git.mjs';

const templateText = readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8');
const base = { ...JSON.parse(templateText), admins: ['owner'] };
const hash = 'abcdef012345'.padEnd(64, '0');
const short = hash.slice(0, 12);
const CONTRACT = '## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert the squash commit.\n';
const verdictBlock = (overrides = {}) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 }, ...overrides })}\n-->`;
const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' });
const comment = (body, login = 'owner') => ({ body, user: { login, type: 'User' }, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' });
const overlap = (extra = {}) => cleanFreshness({ mode: 'overlap', ...extra });

// ---------------------------------------------------------------------------
// The setting.
// ---------------------------------------------------------------------------

test('freshness is optional, and a valid setting is kept as written', () => {
  assert.equal(cleanFreshness(undefined), null);
  const parsed = parseConfig(JSON.stringify({ ...base, freshness: { mode: 'overlap', floor: ['schema/**'], groups: { engine: ['crates/engine/**'] } } }));
  assert.deepEqual(parsed.freshness, { mode: 'overlap', floor: ['schema/**'], groups: { engine: ['crates/engine/**'] } });
  assert.deepEqual(overlap(), { mode: 'overlap', floor: [], groups: {} });
  // The template ships without it.
  assert.equal('freshness' in parseConfig(templateText), false);
});

test('a malformed setting fails closed, to every branch up to date, with a warning', () => {
  for (const value of [
    null,
    'overlap',
    [],
    {},
    { mode: 'loose' },
    { mode: 'overlap', floor: 'x' },
    { mode: 'overlap', floor: [''] },
    { mode: 'overlap', groups: [] },
    { mode: 'overlap', groups: { engine: [] } },
    { mode: 'overlap', groups: { engine: 'crates/**' } },
    { mode: 'overlap', exclude: ['.github/**'] },
  ]) {
    const warnings = [];
    const cleaned = cleanFreshness(value, (m) => warnings.push(m));
    assert.equal(cleaned.mode, 'current', JSON.stringify(value));
    assert.match(warnings[0], /"freshness" .*every branch up to date/);
    // Behind at all is then stale.
    assert.equal(freshnessOf(cleaned, ['README.md'], ['src/a.js']).stale, true);
  }
});

// ---------------------------------------------------------------------------
// The overlap rule.
// ---------------------------------------------------------------------------

test('a branch that is not behind is never stale', () => {
  const result = freshnessOf(overlap(), [], ['src/a.js', 'package.json']);
  assert.deepEqual(result, { mode: 'overlap', behind: false, stale: false, sameFiles: false, reasons: [], files: [] });
});

test('behind with no overlap is fine; a shared file is stale', () => {
  assert.equal(freshnessOf(overlap(), ['src/b.js', 'docs/x.md'], ['src/a.js']).stale, false);
  const stale = freshnessOf(overlap(), ['src/a.js', 'src/b.js'], ['src/a.js']);
  assert.equal(stale.stale, true);
  assert.equal(stale.sameFiles, true);
  assert.deepEqual(stale.files, ['src/a.js']);
  assert.match(stale.reasons[0], /`src\/a\.js`, which this PR also changes/);
  // Compared case-folded, as the tier floors are.
  assert.equal(freshnessOf(overlap(), ['SRC/A.js'], ['src/a.js']).stale, true);
});

test('any floor change stales every PR, and config can add to the floor but not remove from it', () => {
  for (const path of ['pipeline.config.json', 'pipeline.lock.json', '.pipeline/gate.mjs', '.claude/hooks/guard.mjs', '.claude/settings.json', '.github/workflows/ci.yml', '.github/actions/x/action.yml', 'package.json', 'web/package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'Cargo.toml', 'crates/x/Cargo.toml', 'Cargo.lock']) {
    const result = freshnessOf(overlap(), [path], ['src/unrelated.js']);
    assert.equal(result.stale, true, path);
    assert.equal(result.sameFiles, false, path);
    assert.match(result.reasons[0], /every open PR must include/, path);
  }
  assert.equal(freshnessOf(overlap(), ['schema/a.sql'], ['src/a.js']).stale, false);
  assert.equal(freshnessOf(overlap({ floor: ['schema/**'] }), ['schema/a.sql'], ['src/a.js']).stale, true);
  // The built-in floor is a constant, and the config's list only adds to it.
  assert.ok(FRESHNESS_FLOOR.includes('.github/**'));
  assert.equal(freshnessOf(overlap({ floor: [] }), ['.github/workflows/ci.yml'], ['src/a.js']).stale, true);
});

test('a floor or group entry written as a directory covers everything under it', () => {
  for (const entry of ['schema/', 'schema', 'schema//']) {
    assert.equal(freshnessOf(overlap({ floor: [entry] }), ['schema/a.sql'], ['src/a.js']).stale, true, entry);
    assert.equal(freshnessOf(overlap({ floor: [entry] }), ['schema'], ['src/a.js']).stale, true, entry);
    assert.equal(freshnessOf(overlap({ floor: [entry] }), ['schemas/a.sql'], ['src/a.js']).stale, false, entry);
  }
  for (const entry of ['src/auth/', 'src/auth']) {
    assert.equal(freshnessOf(overlap({ groups: { auth: [entry] } }), ['src/auth/a.js'], ['src/auth/deep/b.js']).stale, true, entry);
  }
  // A glob is taken as written.
  assert.equal(freshnessOf(overlap({ floor: ['schema/*.sql'] }), ['schema/deep/a.sql'], ['src/a.js']).stale, false);
  // An entry that is only slashes names nothing, so the setting fails closed.
  assert.equal(cleanFreshness({ mode: 'overlap', floor: ['/'] }).mode, 'current');
});

test('a group is one unit: a change anywhere in it stales a PR touching any of it', () => {
  const setting = overlap({ groups: { engine: ['crates/engine/**'], ui: ['web/**'] } });
  const stale = freshnessOf(setting, ['crates/engine/src/a.rs'], ['crates/engine/src/b.rs']);
  assert.equal(stale.stale, true);
  assert.equal(stale.sameFiles, false);
  assert.match(stale.reasons[0], /in the group "engine"/);
  assert.equal(freshnessOf(setting, ['crates/engine/src/a.rs'], ['web/app.js']).stale, false);
});

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

const gateInput = (overrides = {}) => ({
  changes: [change('src/a.js')],
  hash,
  config: base,
  verify: 'success',
  comments: [],
  ...overrides,
  pr: { author: 'owner', body: `${CONTRACT}\n${verdictBlock()}`, draft: false, base: 'main', ...overrides.pr },
});
const delegated = { ...base, delegates: [{ login: 'gardener', approve: true }] };
const CASES = [
  {},
  { comments: [comment(`/approve ${short}`)] },
  { comments: [comment(`/approve ${short}`, 'gardener')], config: delegated, commitLogins: ['owner'], suspended: false, suspensions: [] },
  { pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
  { pr: { draft: true } },
  { pr: { body: CONTRACT } },
  { verify: 'pending' },
  { verify: 'failure' },
  { mainRed: true },
  { cleanRevert: true, pr: { body: 'Revert-of: abc1234' } },
  { breakerTripped: true, pr: { body: `${CONTRACT}${verdictBlock({ tier: 1 })}` } },
];

test('without freshness, the gate returns exactly what it did before', () => {
  for (const overrides of CASES) {
    const input = gateInput(overrides);
    assert.deepEqual(evaluateGate(input), evaluateBefore(input), JSON.stringify(overrides));
    assert.deepEqual(evaluateGate({ ...input, freshness: null }), evaluateBefore(input), JSON.stringify(overrides));
  }
});

test('a fresh branch, or one behind with no overlap, gets the same verdict as before', () => {
  for (const overrides of CASES) {
    const input = gateInput(overrides);
    for (const freshness of [freshnessOf(overlap(), [], ['src/a.js']), freshnessOf(overlap(), ['docs/x.md'], ['src/a.js'])]) {
      const { freshness: recorded, ...rest } = evaluateGate({ ...input, freshness });
      assert.deepEqual(rest, evaluateBefore(input), JSON.stringify(overrides));
      assert.deepEqual(recorded, freshness);
    }
  }
});

test('a stale branch fails with its own title and marker, never as waiting for approval', () => {
  const held = { changes: [change('src/auth/a.js')] };
  // Without freshness, this change waits for a person.
  assert.equal(evaluateGate(gateInput(held)).title, 'T2: waiting for approval');
  const freshness = freshnessOf(overlap(), ['src/auth/a.js'], ['src/auth/a.js']);
  const waiting = evaluateGate(gateInput({ ...held, freshness }));
  assert.equal(waiting.conclusion, 'failure');
  assert.equal(waiting.title, 'T2: update the branch');
  assert.ok(isStaleSummary(waiting.summary));
  assert.match(waiting.summary, /needs an update from main: main changed `src\/auth\/a\.js`/);
  assert.match(waiting.summary, /needs the council and approval again/);
  // Approved, it still holds.
  const approved = evaluateGate(gateInput({ ...held, freshness, comments: [comment(`/approve ${short}`)] }));
  assert.equal(approved.conclusion, 'failure');
  assert.equal(approved.title, 'T2: update the branch');
  // With other blockers, it is blocked, and still says why and carries the marker.
  const blocked = evaluateGate(gateInput({ ...held, freshness, verify: 'failure' }));
  assert.equal(blocked.title, 'T2: blocked');
  assert.ok(blocked.summary.includes(STALE_MARKER));
  // Floor-only staleness keeps the approval through an update.
  const floor = evaluateGate(gateInput({ ...held, freshness: freshnessOf(overlap(), ['package.json'], ['src/auth/a.js']) }));
  assert.equal(floor.title, 'T2: update the branch');
  assert.match(floor.summary, /a clean update keeps its approval and council verdict/);
});

// ---------------------------------------------------------------------------
// On real git: the overlap, and that a clean update keeps the change hash.
// ---------------------------------------------------------------------------

function repoWith(config) {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'pipeline.config.json': JSON.stringify(config), 'src/a.js': '1\n', 'src/b.js': '1\n', 'package.json': '{}\n' }, 'base');
  return { dir, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('on real git: behind with no overlap passes, and a clean update keeps the change hash', () => {
  const repo = repoWith({ ...base, freshness: { mode: 'overlap' } });
  try {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.commit({ 'src/a.js': '2\n' }, 'pr');
    const before = changeSet('main', 'pr', repo.dir).hash;
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'src/b.js': '2\n' }, 'main moves');
    const behind = freshAt('main', 'pr', repo.dir);
    assert.equal(behind.configured, true);
    assert.equal(behind.behind, true);
    assert.equal(behind.stale, false);
    repo.git('checkout', '-q', 'pr');
    repo.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main');
    assert.equal(changeSet('main', 'pr', repo.dir).hash, before);
    assert.equal(freshAt('main', 'pr', repo.dir).behind, false);
  } finally {
    repo.cleanup();
  }
});

test('on real git: a shared file or a floor path is stale, and only a shared file changes the hash', () => {
  const repo = repoWith({ ...base, freshness: { mode: 'overlap' } });
  try {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.commit({ 'src/a.js': '2\n' }, 'pr');
    const before = changeSet('main', 'pr', repo.dir).hash;
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'package.json': '{"name":"x"}\n' }, 'floor');
    const floor = freshAt('main', 'pr', repo.dir);
    assert.equal(floor.stale, true);
    assert.deepEqual(floor.files, ['package.json']);
    repo.commit({ 'src/a.js': '1\n\n' }, 'same file');
    const both = freshAt('main', 'pr', repo.dir);
    assert.equal(both.sameFiles, true);
    repo.git('checkout', '-q', 'pr');
    repo.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', '-X', 'ours', 'main');
    assert.notEqual(changeSet('main', 'pr', repo.dir).hash, before);
    assert.equal(freshAt('main', 'pr', repo.dir).stale, false);
  } finally {
    repo.cleanup();
  }
});

test('on real git: policy comes from main, so a branch cannot turn freshness off for itself', () => {
  const repo = repoWith({ ...base, freshness: { mode: 'overlap' } });
  try {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.commit({ 'src/a.js': '2\n', 'pipeline.config.json': JSON.stringify(base) }, 'pr drops freshness');
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'src/a.js': '3\n' }, 'main');
    assert.equal(freshAt('main', 'pr', repo.dir).stale, true);
  } finally {
    repo.cleanup();
  }
  const off = repoWith(base);
  try {
    assert.deepEqual(freshAt('main', 'HEAD', off.dir), { configured: false, stale: false });
  } finally {
    off.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Publishing, and re-evaluating when main moves.
// ---------------------------------------------------------------------------

// Answers main's ref from a list, and records every check it's asked to publish.
const pubClient = (shas) => {
  const reads = [];
  const published = [];
  return {
    reads,
    published,
    get: async (path) => (reads.push(path), { object: { sha: shas.length > 1 ? shas.shift() : shas[0] } }),
    post: async (path, body) => (published.push(body), {}),
  };
};
const pass = { tier: 2, conclusion: 'success', status: 'completed', title: 'T2: ready to merge', summary: 's' };
const staleResult = { ...pass, conclusion: 'failure', title: 'T2: update the branch' };
const pubInput = (baseSha = 'm1') => ({ pr: { head: 'h7', url: 'u7' }, config: base, defaultBranch: 'main', freshness: { stale: false }, baseSha });

test('without freshness, a publish reads nothing more', async () => {
  const client = pubClient(['m2']);
  const out = await publishFresh(client, 'o/r', 7, '.', { ...pubInput(), freshness: undefined }, pass, {}, () => assert.fail('no re-evaluation'));
  assert.equal(out.result, pass);
  assert.deepEqual(client.reads, []);
  assert.deepEqual(client.published.map((b) => b.conclusion), ['success']);
});

test('a pass goes out only for the main that is current, checked before and after publishing', async () => {
  const still = pubClient(['m1']);
  await publishFresh(still, 'o/r', 7, '.', pubInput(), pass, {}, () => assert.fail('no re-evaluation'));
  assert.equal(still.published.length, 1);
  assert.equal(still.reads.length, 2);
  // Main moved before publishing: the pass never goes out.
  const before = pubClient(['m2']);
  await publishFresh(before, 'o/r', 7, '.', pubInput(), pass, {}, async () => ({ input: pubInput('m2'), result: staleResult }));
  assert.deepEqual(before.published.map((b) => b.conclusion), ['failure']);
  // Main moved just after: the run evaluates again and publishes over it, so the last writer is current.
  const after = pubClient(['m1', 'm2']);
  await publishFresh(after, 'o/r', 7, '.', pubInput(), pass, {}, async () => ({ input: pubInput('m2'), result: staleResult }));
  assert.deepEqual(after.published.map((b) => b.conclusion), ['success', 'failure']);
  // Anything but a pass publishes at once.
  const waiting = pubClient(['m9']);
  await publishFresh(waiting, 'o/r', 7, '.', pubInput(), { ...pass, conclusion: 'action_required' }, {}, () => assert.fail('no re-evaluation'));
  assert.deepEqual(waiting.reads, []);
});

test('if main keeps moving, the newest evaluation goes out, and nothing is left in progress', async () => {
  const moving = pubClient(['m2', 'm3', 'm4', 'm5', 'm6']);
  let n = 0;
  const out = await publishFresh(moving, 'o/r', 7, '.', pubInput(), pass, {}, async () => ({ input: pubInput(`old${(n += 1)}`), result: pass }));
  assert.equal(out.result.conclusion, 'success');
  assert.equal(moving.published.length, 1);
  assert.ok(moving.published.every((body) => body.status === 'completed'));
});

test('a new head is marked in progress before anything is evaluated', () => {
  const pr = { head: { sha: 'h7' }, html_url: 'u7' };
  const body = evaluatingBody(pr, base, '42');
  assert.equal(body.status, 'in_progress');
  assert.equal(body.head_sha, 'h7');
  assert.equal('conclusion' in body, false);
  assert.equal('external_id' in body, false);
  assert.equal(evaluatingBody(pr, delegated, '42').external_id, '42');
});

test('each check says which main it was evaluated against', () => {
  const freshness = { ...freshnessOf(overlap(), [], ['src/a.js']), base: 'f'.repeat(40) };
  for (const overrides of [{}, { verify: 'failure' }, { changes: [change('src/auth/a.js')] }]) {
    assert.match(evaluateGate(gateInput({ ...overrides, freshness })).summary, /Evaluated against `ffffffffffff` on the default branch\.\n<!-- pipeline:base f{40} -->$/);
  }
});

const gateRun = (conclusion, summary = '', at = '2026-11-09T10:00:00Z') => [
  { id: 1, name: 'pipeline/gate', app: { slug: 'github-actions' }, status: 'completed', conclusion, started_at: at, completed_at: at, output: { summary } },
];
const openPr = (number, extra = {}) => ({ number, state: 'open', draft: false, head: { sha: `h${number}` }, base: { ref: 'main', repo: { default_branch: 'main' } }, ...extra });

test('when main moves, only PRs whose freshness verdict changes are evaluated in full', async () => {
  const client = fakeGitHub({
    pulls: [openPr(1), openPr(2), openPr(3), openPr(4), openPr(5, { draft: true }), openPr(6, { base: { ref: 'release', repo: { default_branch: 'main' } } }), openPr(7)],
    checkRuns: {
      h1: gateRun('success'),
      h2: gateRun('action_required'),
      h3: gateRun('failure', `held\n${STALE_MARKER}`),
      h4: gateRun('failure', `held\n${STALE_MARKER}`),
      h5: gateRun('success'),
      h6: gateRun('success'),
      h7: gateRun('failure', 'blocked for something else'),
    },
  });
  // 1 is newly stale; 2 is still fresh; 3 was held but main reverted the overlap; 4 is still held; 7 fails for another reason and is now stale too.
  const stale = { 1: true, 2: false, 3: false, 4: true, 7: true };
  const calls = [];
  const options = { republish: async (c, repo, numbers, cwd, opts) => (calls.push({ numbers, opts }), []), freshnessOfPr: (number) => ({ stale: stale[number] }) };
  assert.deepEqual(await mainMoved(client, 'o/r', base, '.', options), { skipped: 'freshness is not configured' });
  assert.deepEqual(calls, []);
  await mainMoved(client, 'o/r', { ...base, freshness: overlap() }, '.', { ...options, since: '2026-11-09T11:00:00Z' });
  assert.deepEqual(calls, [{ numbers: [1, 3, 7], opts: { since: '2026-11-09T11:00:00Z' } }]);
});

test('on real git: the push run reads each PR\'s freshness locally, from the remote\'s refs', async () => {
  const repo = repoWith({ ...base, freshness: { mode: 'overlap' } });
  const remote = mkdtempSync(join(tmpdir(), 'freshness-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', remote]);
    repo.git('remote', 'add', 'origin', remote);
    repo.git('checkout', '-q', '-b', 'one');
    repo.commit({ 'src/a.js': '2\n' }, 'touches a');
    repo.git('push', '-q', 'origin', 'HEAD:refs/pull/1/head');
    repo.git('checkout', '-q', '-b', 'two', 'main');
    repo.commit({ 'src/c.js': '1\n' }, 'touches c');
    repo.git('push', '-q', 'origin', 'HEAD:refs/pull/2/head');
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'src/a.js': '3\n' }, 'main touches a');
    repo.git('push', '-q', 'origin', 'main');
    const client = fakeGitHub({ pulls: [openPr(1), openPr(2)], checkRuns: { h1: gateRun('success'), h2: gateRun('success') } });
    const seen = [];
    await mainMoved(client, 'o/r', { ...base, freshness: overlap() }, repo.dir, { republish: async (c, r, numbers) => (seen.push(...numbers), []) });
    assert.deepEqual(seen, [1]);
  } finally {
    repo.cleanup();
    rmSync(remote, { recursive: true, force: true });
  }
});

test("a PR whose freshness can't be read locally is evaluated in full", async () => {
  const client = fakeGitHub({ pulls: [openPr(1), openPr(2)], checkRuns: { h1: gateRun('success'), h2: gateRun('failure', STALE_MARKER) } });
  const calls = [];
  await mainMoved(client, 'o/r', { ...base, freshness: overlap() }, '.', {
    republish: async (c, repo, numbers) => (calls.push(...numbers), []),
    freshnessOfPr: () => {
      throw new Error('no such ref');
    },
  });
  assert.deepEqual(calls, [1, 2]);
});

test('a re-evaluation leaves alone a gate that another run published after it started', () => {
  const [check] = gateRun('failure', '', '2026-11-09T11:00:05Z');
  assert.equal(publishedSince(check, '2026-11-09T11:00:00Z'), true);
  assert.equal(publishedSince(check, '2026-11-09T11:00:10Z'), false);
  assert.equal(publishedSince(null, '2026-11-09T11:00:00Z'), false);
});

test("gate.yml's push run may re-publish on the default branch, and nowhere else", () => {
  const check = { app: { slug: 'github-actions' }, external_id: 'republish:42', completed_at: '2026-11-09T10:01:00Z' };
  const run = { path: '.github/workflows/gate.yml', event: 'push', head_branch: 'main', repository: { full_name: 'o/r' }, run_started_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:02:00Z' };
  assert.deepEqual(gateRunProblems(check, run, 'o/r'), []);
  // And from its hourly run, which catches a PR that a failed push run missed.
  assert.deepEqual(gateRunProblems(check, { ...run, event: 'schedule' }, 'o/r'), []);
  assert.match(gateRunProblems(check, { ...run, head_branch: 'feature' }, 'o/r').join('; '), /ran on feature/);
  assert.match(gateRunProblems(check, { ...run, event: 'workflow_dispatch' }, 'o/r').join('; '), /re-publish came from a workflow_dispatch run/);
  // A push run's own, unmarked check still isn't a gate run.
  assert.match(gateRunProblems({ ...check, external_id: '42' }, run, 'o/r').join('; '), /triggered by push/);
});

// ---------------------------------------------------------------------------
// Who reads a stale result.
// ---------------------------------------------------------------------------

test("the inbox doesn't list a stale branch as a call to make", async () => {
  const gate = [{ id: 1, name: 'pipeline/gate', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'action_required' }];
  const pulls = [7, 8].map((number) => ({ number, title: `#${number}`, html_url: `u${number}`, user: { login: 'owner' }, head: { sha: `h${number}`, ref: `f${number}`, repo: { full_name: 'o/r' } }, base: { repo: { default_branch: 'main' } }, state: 'open', updated_at: '2026-11-19T00:00:00Z' }));
  const client = fakeGitHub({ pulls, checkRuns: { h7: gate, h8: gate } });
  const evaluate = async (c, repo, number) =>
    evaluateGate(gateInput({ config: delegated, commitLogins: ['owner'], suspended: false, suspensions: [], freshness: freshnessOf(overlap(), number === 7 ? ['src/a.js'] : [], ['src/a.js']) }));
  const inbox = await buildInbox({ client, repo: 'o/r', config: delegated, now: new Date('2026-11-20T00:00:00Z'), login: 'gardener', evaluate, branches: () => [], projectCounts: () => ({}) });
  assert.deepEqual(inbox.prs.map((item) => item.number), [8]);
});

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test('pr-wait reads a stale gate as "update the branch", and says so when it is blocked for more', { skip: !python && 'python not installed' }, () => {
  const run = (summary, slug = 'github-actions', title = 'T2: update the branch') =>
    JSON.stringify({ check_runs: [{ id: 1, name: 'pipeline/gate', app: { slug: 'github-actions' }, output: { summary: 'older' } }, { id: 2, name: 'pipeline/gate', app: { slug }, output: { title, summary } }] });
  const code = [
    'import importlib.machinery, importlib.util, json, subprocess, sys',
    `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
    'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
    'loader.exec_module(mod)',
    'answers = json.loads(sys.argv[1])',
    'out = []',
    'for answer in answers:',
    '    mod.gh = lambda args, allow=(0,), a=answer: subprocess.CompletedProcess(args, 0, a, "")',
    '    w = object.__new__(mod.Watcher); w.repo = "o/r"',
    '    out.append(w.gate_stale("abc"))',
    'print(json.dumps(out))',
  ].join('\n');
  const answers = [run(`held\n${STALE_MARKER}`), run(`held\n${STALE_MARKER}`, 'github-actions', 'T2: blocked'), run('T2: blocked', 'github-actions', 'T2: blocked'), run(STALE_MARKER, 'someone-else'), 'not json'];
  const result = spawnSync(python, ['-c', code, JSON.stringify(answers)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Only the latest gate check from GitHub Actions counts. Blocked for more than the update, it says both.
  assert.deepEqual(JSON.parse(result.stdout), ['only', 'also', '', '', '']);
});

// ---------------------------------------------------------------------------
// doctor, and the digest.
// ---------------------------------------------------------------------------

test("doctor reports when freshness and GitHub's up-to-date rule don't fit together", () => {
  const on = { ...base, freshness: { mode: 'overlap' } };
  assert.equal(freshnessCheck(base, true), null);
  assert.equal(freshnessCheck(base, null), null);
  assert.equal(freshnessCheck(null, true), null);
  assert.match(freshnessCheck(base, false).detail, /^UNGUARDED/);
  assert.equal(freshnessCheck(base, false).level, 'warn');
  assert.match(freshnessCheck(on, true, ['main']).detail, /no effect yet.*never an agent/);
  assert.equal(freshnessCheck(on, false, ['main']).level, 'ok');
  assert.match(freshnessCheck(on, null, ['main']).detail, /could not be read/);
  assert.match(freshnessCheck(on, false, null).detail, /gate\.yml does not run on a push to main/);
  // A default branch that isn't main needs gate.yml's push branches to name it.
  assert.match(freshnessCheck(on, false, ['main'], 'trunk').detail, /does not run on a push to trunk/);
  assert.equal(freshnessCheck(on, false, ['main', 'trunk'], 'trunk').level, 'ok');
  assert.match(freshnessCheck({ ...base, freshness: { mode: 'loose' } }, false, ['main']).detail, /unknown mode/);
});

test("doctor reads gate.yml's push branches, and the up-to-date rule in a ruleset-only repo", () => {
  assert.deepEqual(pushBranches("on:\n  push:\n    branches: [main, 'trunk']\n"), ['main', 'trunk']);
  assert.equal(pushBranches('on:\n  pull_request_target:\n'), null);
  assert.equal(strictFrom('true', 'false'), true);
  assert.equal(strictFrom('false', 'true'), true);
  assert.equal(strictFrom('false', 'false'), false);
  // No branch protection at all, as in a ruleset-only repo: the rulesets decide.
  const none = '{"message":"Branch not protected","status":"404"}gh: Branch not protected (HTTP 404)';
  assert.equal(strictFrom(none, 'false'), false);
  assert.equal(strictFrom(none, 'true'), true);
  // Anything else unreadable stays unknown.
  assert.equal(strictFrom('gh: Resource not accessible by integration (HTTP 403)', 'false'), null);
  assert.equal(strictFrom(none, null), null);
});

test('the digest counts merges made while behind, and the reverts and red mains after them', () => {
  const merged = [
    { number: 1, body: '', merge_commit_sha: 'aaa1111' },
    { number: 2, body: '', merge_commit_sha: 'bbb2222' },
    { number: 3, body: '', merge_commit_sha: 'ccc3333' },
    { number: 4, body: 'Revert-of: aaa1111', merge_commit_sha: 'ddd4444' },
  ];
  const behind = new Map([[1, true], [2, true], [3, false], [5, null]]);
  const red = [{ number: 40, title: 'Main is red at bbb2222' }, { number: 41, title: 'Main is red at ccc3333' }];
  const summary = freshnessSummary(merged, behind, red);
  assert.deepEqual(summary, { checked: 3, unknown: 1, whileBehind: [1, 2], reverted: [1], redMain: [40] });
  const text = renderDigest({ since: '2026-11-01T00:00:00Z', summary: { ...summaryShape(), freshness: summary }, decisions: [], state: { breaker: [], mainRed: [], audit: [] } });
  assert.match(text, /## Merging while behind main/);
  assert.match(text, /Merged while behind main: 2 of 3 \(#1, #2\)/);
  assert.match(text, /Reverted afterwards: 1 \(#1\)/);
  assert.match(text, /Main went red at one: at least 1 \(#40\)\. A red main reported on a later merge's run/);
  assert.match(text, /Not checked: 1/);
  assert.doesNotMatch(renderDigest({ since: '2026-11-01T00:00:00Z', summary: summaryShape(), decisions: [], state: { breaker: [], mainRed: [], audit: [] } }), /behind main/);
});

function summaryShape() {
  return {
    merged: 0,
    byTier: { 0: 0, 1: 0, 2: 0, revert: 0 },
    humanTouches: { median: null, p95: null },
    decisionWait: { median: null },
    rounds: { median: null, p95: null, fiveOrMore: 0 },
    size: { median: null, p95: null },
    reverted: [],
    dispositions: {},
    approvals: [],
  };
}

test('the digest reads behind from GitHub only with freshness configured', async () => {
  const pulls = [{ number: 9, state: 'closed', merged_at: '2026-11-08T00:00:00Z', body: '', merge_commit_sha: 'm9', head: { sha: 'h9' } }];
  const routes = { 'GET /repos/o/r/commits/m9': { parents: [{ sha: 'p9' }] }, 'GET /repos/o/r/compare/p9...h9': { behind_by: 2 } };
  const botIssues = async () => [];
  const now = new Date('2026-11-10T00:00:00Z');
  const without = fakeGitHub({ pulls, routes });
  const plain = await buildDigest({ client: without, repo: 'o/r', now, config: base, botIssues });
  assert.equal('freshness' in plain.summary, false);
  assert.equal(without.calls.some((call) => /compare|commits\/m9/.test(call.path ?? '')), false);
  const withIt = await buildDigest({ client: fakeGitHub({ pulls, routes }), repo: 'o/r', now, config: { ...base, freshness: overlap() }, botIssues });
  assert.deepEqual(withIt.summary.freshness.whileBehind, [9]);
});
