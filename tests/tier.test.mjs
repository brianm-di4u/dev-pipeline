import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { matchesAny, normalizePath } from '../template/.pipeline/lib/paths.mjs';
import { classify } from '../template/.pipeline/lib/tier.mjs';

const config = JSON.parse(readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8'));
config.admins = ['owner'];

const file = (path, newMode = '100644') => ({
  path,
  oldMode: '100644',
  newMode,
  oldSha: 'a'.repeat(40),
  newSha: 'b'.repeat(40),
  status: 'M',
});
const tierOf = (paths, extra = {}) =>
  classify({ changes: paths.map((p) => (typeof p === 'string' ? file(p) : p)), config, author: 'owner', ...extra });

test('globs match at any depth and are case-folded', () => {
  assert.ok(matchesAny('src/auth/login.js', ['**/auth/**']));
  assert.ok(matchesAny('auth/login.js', ['**/auth/**']));
  assert.ok(matchesAny('.Claude/Hooks/x.mjs', ['.claude/hooks/**']));
  assert.ok(!matchesAny('src/author.js', ['**/auth/**']));
  assert.ok(matchesAny('docs/a/b.md', ['docs/**/*.md']));
  assert.ok(matchesAny('docs/b.md', ['docs/**/*.md']));
  assert.ok(!matchesAny('docs/b.js', ['docs/**/*.md']));
});

test('NTFS-ignored trailing dots and spaces cannot dodge a floor', () => {
  assert.equal(normalizePath('.claude./hooks /x.mjs'), '.claude/hooks/x.mjs');
  assert.equal(tierOf(['.claude./hooks/x.mjs']).tier, 2);
});

test('markdown docs are T0', () => {
  assert.equal(tierOf(['docs/guide.md', 'README.md']).tier, 0);
});

test('non-markdown in docs is not T0, since docs/ can be served or built', () => {
  assert.equal(tierOf(['docs/script.js']).tier, 1);
  assert.equal(tierOf(['docs/guide.md', 'src/app.js']).tier, 1);
});

test('tests are T1, because they execute and can drop assertions', () => {
  assert.equal(tierOf(['tests/a.test.js']).tier, 1);
});

test('skills, CLAUDE.md, and REVIEW.md are T1, so the fix ladder works unattended', () => {
  assert.equal(tierOf(['.claude/skills/x/SKILL.md']).tier, 1);
  assert.equal(tierOf(['CLAUDE.md']).tier, 1);
  assert.equal(tierOf(['REVIEW.md']).tier, 1);
});

for (const path of [
  '.github/workflows/ci.yml',
  '.pipeline/gate.mjs',
  '.pipeline/AUTONOMY.md',
  'pipeline.config.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/guard.mjs',
  '.claude/agents/council-x.md',
  '.claude/workflows/round.js',
  'LICENSE',
  'THIRD_PARTY.md',
  'docs/PRD.md',
  'src/auth/session.ts',
  'db/migrations/001.sql',
  'crates/app/build.rs',
  '.cargo/config.toml',
  '.gitattributes',
]) {
  test(`protected path is T2: ${path}`, () => {
    assert.equal(tierOf([path]).tier, 2);
  });
}

test('a delete of a protected path is T2 (a moved workflow reports its source)', () => {
  const moved = [
    { ...file('.github/workflows/ci.yml'), newMode: '000000', newSha: '0'.repeat(40), status: 'D' },
    { ...file('docs/ci.yml'), oldMode: '000000', oldSha: '0'.repeat(40), status: 'A' },
  ];
  assert.equal(tierOf(moved).tier, 2);
});

test('a symlink in docs is T2, since it could point anywhere', () => {
  const result = tierOf([file('docs/guide.md', '120000')]);
  assert.equal(result.tier, 2);
  assert.match(result.reasons[0], /Symlink/);
});

test('an executable docs file is not T0', () => {
  assert.equal(tierOf([file('docs/guide.md', '100755')]).tier, 1);
});

test('external authors are T2, even on docs', () => {
  assert.equal(tierOf(['README.md'], { author: 'stranger' }).tier, 2);
});

test('trusted bots are T1 for dependency work, not T2 and not auto T0', () => {
  assert.equal(tierOf(['package-lock.json'], { author: 'dependabot[bot]' }).tier, 1);
  assert.equal(tierOf(['.github/workflows/ci.yml'], { author: 'dependabot[bot]' }).tier, 2);
});

test('changed package.json scripts are T2', () => {
  assert.equal(tierOf(['package.json'], { scriptsChangedIn: ['package.json'] }).tier, 2);
  assert.equal(tierOf(['package.json']).tier, 1);
});

test('AI can raise a tier', () => {
  const result = tierOf(['README.md'], { aiRaise: { reason: 'Exposes a design decision' } });
  assert.equal(result.tier, 2);
  assert.match(result.reasons[0], /Raised by council/);
});

test('a decision record is T0 only when it cites a /decide', () => {
  assert.equal(tierOf(['docs/decisions/0002-x.md']).tier, 2);
  assert.equal(tierOf(['docs/decisions/0002-x.md'], { adrCited: true }).tier, 0);
  assert.equal(tierOf(['docs/decisions/0002-x.md', 'src/a.js'], { adrCited: true }).tier, 1);
});

test('a verified clean revert is T0, but a protected path still wins', () => {
  assert.equal(tierOf(['src/a.js'], { cleanRevert: true }).tier, 0);
  assert.equal(tierOf(['.github/x.yml'], { cleanRevert: true }).tier, 2);
});

test('PRD and threat model are excluded from the T0 fast path', () => {
  assert.equal(tierOf(['docs/THREAT-MODEL.md']).tier, 1);
  assert.equal(tierOf(['docs/PRD.md']).tier, 2);
});
