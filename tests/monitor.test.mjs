import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowlist, isAllowed, problems } from '../template/.pipeline/check-licenses.mjs';
import { criteria, uncovered } from '../template/.pipeline/check-acceptance.mjs';
import { citedPaths, missingPaths } from '../template/.pipeline/check-docs.mjs';
import { evaluateBreaker } from '../template/.pipeline/lib/breaker.mjs';
import { percentile, releaseDownloads, renderDigest, summarize } from '../template/.pipeline/lib/digest.mjs';
import { auditProblems } from '../template/.pipeline/monitor.mjs';

const config = { admins: ['owner'], breaker: { window: 20, maxFailures: 3 } };
const verdict = (tier, extra = {}) =>
  `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: 'abc'.padEnd(64, '0'), tier, rounds: 1, open: { blocker: 0, should: 0 }, ...extra })}\n-->`;

const merge = (number, tier, day = 10) => ({
  number,
  merged_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
  merge_commit_sha: `f${number}f`.padEnd(40, '0'),
  body: verdict(tier),
});
const revertOf = (number, target, day = 11) => ({
  number,
  merged_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
  merge_commit_sha: `f${number}f`.padEnd(40, '0'),
  body: `Revert-of: ${`f${target}f`.padEnd(40, '0')}`,
});

test('the breaker stays quiet below its limit', () => {
  const result = evaluateBreaker({ merges: [merge(1, 1), merge(2, 1), revertOf(3, 1)], redIssues: [], config });
  assert.equal(result.tripped, false);
  assert.equal(result.failures, 1);
});

test('three reverts in the window trip the breaker', () => {
  const merges = [merge(1, 1), merge(2, 1), merge(3, 1), revertOf(4, 1), revertOf(5, 2), revertOf(6, 3)];
  const result = evaluateBreaker({ merges, redIssues: [], config });
  assert.equal(result.tripped, true);
  assert.deepEqual(result.reverted.sort(), [1, 2, 3]);
});

test('a red main counts, without depending on agents choosing to revert', () => {
  const merges = [merge(1, 1)];
  const red = (n) => ({ number: n, created_at: '2026-11-10T12:00:00Z' });
  const result = evaluateBreaker({ merges, redIssues: [red(7), red(8), red(9)], config });
  assert.equal(result.tripped, true);
  assert.equal(result.failures, 3);
});

test('docs merges cannot dilute the window', () => {
  const docs = Array.from({ length: 40 }, (_, i) => merge(100 + i, 0, 12));
  const merges = [merge(1, 1), merge(2, 1), merge(3, 1), revertOf(4, 1), revertOf(5, 2), revertOf(6, 3), ...docs];
  assert.equal(evaluateBreaker({ merges, redIssues: [], config }).tripped, true);
});

test('T1 merges beyond the window age out', () => {
  const recent = Array.from({ length: 20 }, (_, i) => merge(100 + i, 1, 20));
  const merges = [merge(1, 1, 1), merge(2, 1, 1), merge(3, 1, 1), revertOf(4, 1, 2), revertOf(5, 2, 2), revertOf(6, 3, 2), ...recent];
  assert.equal(evaluateBreaker({ merges, redIssues: [], config }).tripped, false);
});

test('after a re-arm the count starts over', () => {
  const merges = [merge(1, 1), merge(2, 1), merge(3, 1), revertOf(4, 1), revertOf(5, 2), revertOf(6, 3)];
  assert.equal(evaluateBreaker({ merges, redIssues: [], config, since: '2026-11-15T00:00:00Z' }).tripped, false);
});

const healthy = {
  protected: true,
  protection: {
    enabled: true,
    required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'pipeline/gate', app_id: 15368 }] },
  },
};

test('the audit passes healthy protection', () => {
  assert.deepEqual(auditProblems(healthy), []);
});

test('the audit catches each way protection can be weakened', () => {
  assert.ok(auditProblems({ protected: false }).length > 0);
  assert.ok(
    auditProblems({
      ...healthy,
      protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'pipeline/gate', app_id: null }] } },
    }).some((p) => /pinned/.test(p)),
    'an unpinned check',
  );
  assert.ok(
    auditProblems({
      ...healthy,
      protection: { enabled: true, required_status_checks: { enforcement_level: 'non_admins', checks: healthy.protection.required_status_checks.checks } },
    }).some((p) => /admins/.test(p)),
    'admins exempted',
  );
});

test('percentile', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
});

test('the digest counts tiers, rounds, reverts, dispositions, and approvals', () => {
  const hash = 'abc'.padEnd(64, '0');
  const merged = [
    { number: 1, body: verdict(0) },
    { number: 2, body: verdict(1, { rounds: 2, diff: { first: 10, final: 12 }, findings: [{ disposition: 'fixed' }, { disposition: 'wrong' }] }) },
    { number: 3, body: verdict(2, { rounds: 5 }) },
    { number: 4, body: 'Revert-of: abc1234' },
  ];
  const commentsByPr = new Map([
    [3, [{ body: `/approve ${hash.slice(0, 12)}`, user: { login: 'owner', type: 'User' }, created_at: 't', updated_at: 't' }]],
  ]);
  const summary = summarize({ merged, commentsByPr, decisions: [{ open: true, waitHours: null }, { open: false, waitHours: 6 }], config });
  assert.deepEqual(summary.byTier, { 0: 1, 1: 1, 2: 1, revert: 1 });
  assert.equal(summary.rounds.fiveOrMore, 1);
  assert.deepEqual(summary.dispositions, { fixed: 1, wrong: 1 });
  assert.equal(summary.approvals.length, 1);
  assert.equal(summary.approvals[0].pr, 3);
  assert.equal(summary.decisionWait.median, 6);

  const text = renderDigest({
    since: '2026-11-01T00:00:00Z',
    summary,
    decisions: [{ number: 9, title: 'Decision: license', open: true }],
    state: { breaker: [5], mainRed: [], audit: [] },
  });
  assert.match(text, /Needs attention/);
  assert.match(text, /Circuit breaker tripped: #5/);
  assert.match(text, /#9 Decision: license/);
  assert.match(text, /#3 by owner/);
});

const THIRD_PARTY = `# Third-party content

## Allowed licenses

Code may be adapted only under these licenses:

MIT, BSD-3-Clause, ISC, Apache-2.0, MPL-2.0 (dependencies only, unmodified)

Anything else is reference-only.

## Record
`;

test('the license allowlist is read from THIRD_PARTY.md', () => {
  const allowed = allowlist(THIRD_PARTY);
  assert.ok(allowed.has('mit'));
  assert.ok(allowed.has('mpl-2.0'));
  assert.ok(!allowed.has('gpl-3.0'));
});

test('license expressions', () => {
  const allowed = allowlist(THIRD_PARTY);
  assert.ok(isAllowed('MIT', allowed));
  assert.ok(isAllowed('(MIT OR GPL-3.0)', allowed));
  assert.ok(!isAllowed('GPL-3.0', allowed));
  assert.ok(!isAllowed('(MIT AND GPL-3.0)', allowed));
  assert.ok(!isAllowed(undefined, allowed));
});

test('a GPL dependency is flagged, and an explicit exception clears it', () => {
  const allowed = allowlist(THIRD_PARTY);
  const lock = {
    packages: {
      '': { name: 'app' },
      'node_modules/ok': { version: '1.0.0', license: 'MIT' },
      'node_modules/bad': { version: '2.0.0', license: 'GPL-3.0' },
      'node_modules/unlicensed': { version: '3.0.0' },
    },
  };
  assert.deepEqual(problems(lock, allowed).map((p) => p.name), ['bad', 'unlicensed']);
  assert.deepEqual(problems(lock, allowed, ['bad']).map((p) => p.name), ['unlicensed']);
});

test('instruction files fail when they cite a path that no longer exists', () => {
  const markdown = [
    '@.pipeline/AUTONOMY.md',
    'See [the PRD](docs/PRD.md#goals), [the site](https://example.com), and [gone](docs/gone.md).',
    '- `node .pipeline/verify.mjs fast`: quick checks.',
    '- `node .pipeline/removed.mjs`: gone too.',
    '<!-- [ignored](docs/comment.md) -->',
  ].join('\n');
  assert.deepEqual(citedPaths(markdown).sort(), ['.pipeline/AUTONOMY.md', '.pipeline/removed.mjs', '.pipeline/verify.mjs', 'docs/PRD.md', 'docs/gone.md']);
  const exists = (path) => !/gone|removed/.test(path);
  assert.deepEqual(missingPaths('CLAUDE.md', markdown, exists).sort(), ['.pipeline/removed.mjs', 'docs/gone.md']);
});

test('acceptance criteria: blank placeholders do not count, and each real one needs a test', () => {
  assert.deepEqual(criteria('- **AC-1:** <!-- Given..., when..., then... -->\n'), []);
  const prd = '- **AC-1:** A tap scores a point.\n- **AC-2:** Scores persist.\n- **AC-10:** Works offline.\n';
  assert.deepEqual(criteria(prd), ['AC-1', 'AC-2', 'AC-10']);
  assert.deepEqual(uncovered(['AC-1', 'AC-2', 'AC-10'], "test('AC-1: scores', ...); test('AC-100: x', ...)"), ['AC-2', 'AC-10']);
});

test('the digest lists release downloads, skips drafts, and omits the section with no releases', () => {
  const downloads = releaseDownloads([
    { tag_name: 'v3', draft: true, assets: [{ name: 'x', download_count: 99 }] },
    { tag_name: 'v2', draft: false, assets: [{ name: 'a', download_count: 2 }, { name: 'b', download_count: 5 }] },
    { tag_name: 'v1', draft: false, assets: [] },
  ]);
  assert.deepEqual(downloads, [
    { tag: 'v2', total: 7, top: 'b' },
    { tag: 'v1', total: 0, top: null },
  ]);

  const base = {
    since: '2026-11-01T00:00:00Z',
    summary: {
      merged: 0, byTier: { 0: 0, 1: 0, 2: 0, revert: 0 }, humanTouches: {}, decisionWait: {}, rounds: {}, size: {},
      reverted: [], dispositions: {}, approvals: [],
    },
    decisions: [],
    state: { breaker: [], mainRed: [], audit: [] },
  };
  assert.doesNotMatch(renderDigest(base), /Release downloads/);
  assert.match(renderDigest({ ...base, downloads }), /\| v2 \| 7 \| b \|/);
});
