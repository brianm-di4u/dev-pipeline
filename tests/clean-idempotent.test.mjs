// Cleaning the config twice changes nothing. parseConfig cleans it once, and every
// authority() call, in the gate and the monitor, cleans the cleaned config again.
// A field cleaning wrote as null must read back as absent, or the second pass drops
// every delegate, and the admin-only floor with them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { grantCovers } from '../template/.claude/hooks/guard.mjs';
import { ADMIN_ONLY_FLOOR, authority, cleanDelegates } from '../template/.pipeline/lib/authority.mjs';
import { loadConfig, parseConfig } from '../template/.pipeline/lib/config.mjs';
import { cleanFreshness } from '../template/.pipeline/lib/freshness.mjs';
import { evaluateGate } from '../template/.pipeline/lib/gate-core.mjs';

const template = JSON.parse(readFileSync(new URL('../template/pipeline.config.json', import.meta.url), 'utf8'));
const ENTRIES = [
  { login: 'gardener', approve: true },
  { login: 'gardener', approve: true, since: '2026-11-10T00:00:00Z' },
  { login: 'gardener', approve: true, id: 42 },
  { login: 'gardener', approve: true, decide: ['design'], rearm: true, direct: true, since: '2026-11-10T00:00:00Z', id: 42 },
  { login: 'gardener', since: null, id: null },
];

test('cleaning a delegates list twice gives the same list, with no warning', () => {
  for (const entry of ENTRIES) {
    const config = { admins: ['owner'], delegates: [entry, { login: 'helper', approve: true }] };
    const once = cleanDelegates(config);
    assert.equal(once.length, 2, JSON.stringify(entry));
    const warnings = [];
    assert.deepEqual(cleanDelegates({ ...config, delegates: once }, (m) => warnings.push(m)), once, JSON.stringify(entry));
    assert.deepEqual(warnings, [], JSON.stringify(entry));
  }
});

test('parsing a parsed config gives the same config', () => {
  for (const extra of [
    { delegates: ENTRIES },
    { freshness: { mode: 'overlap', floor: ['schema/'], groups: { e: ['crates/e/**'] } } },
    { freshness: { mode: 'loose' } },
    { models: { worker: 'claude-opus-5-5' } },
  ]) {
    const once = parseConfig(JSON.stringify({ ...template, admins: ['owner'], ...extra }), { warn: () => {} });
    const warnings = [];
    assert.deepEqual(parseConfig(JSON.stringify(once), { warn: (m) => warnings.push(m) }), once, JSON.stringify(extra));
    assert.deepEqual(warnings, [], JSON.stringify(extra));
  }
  assert.deepEqual(cleanFreshness(cleanFreshness({ mode: 'loose' })), cleanFreshness({ mode: 'loose' }));
});

function configFile(delegates) {
  const dir = mkdtempSync(join(tmpdir(), 'clean-idempotent-'));
  const path = join(dir, 'pipeline.config.json');
  writeFileSync(path, JSON.stringify({ ...template, admins: ['owner'], delegates }));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('through the real path, loadConfig then authority, the delegate and the floor stay', () => {
  for (const entry of ENTRIES.slice(0, 4)) {
    const file = configFile([entry]);
    try {
      const auth = authority(loadConfig(file.path, { warn: () => {} }));
      assert.equal(auth.delegates.length, 1, JSON.stringify(entry));
      assert.ok(ADMIN_ONLY_FLOOR.every((path) => auth.adminOnlyPaths.includes(path)), JSON.stringify(entry));
    } finally {
      file.cleanup();
    }
  }
});

test("the gate counts a delegate's approval with a config loaded from disk", () => {
  const hash = 'abcdef012345'.padEnd(64, '0');
  const at = '2026-11-10T10:00:00Z';
  const file = configFile([{ login: 'gardener', approve: true }]);
  try {
    const result = evaluateGate({
      pr: {
        author: 'owner',
        body: `## Testing\nRan it.\n\n## Risk\nLow.\n\n## How to revert\nRevert it.\n\n<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 2, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`,
        draft: false,
        base: 'main',
      },
      changes: [{ path: 'src/auth/a.js', oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b', status: 'M' }],
      hash,
      config: loadConfig(file.path, { warn: () => {} }),
      verify: 'success',
      comments: [{ body: '/approve abcdef012345', user: { login: 'gardener', type: 'User' }, author_association: 'COLLABORATOR', created_at: at, updated_at: at }],
      commitLogins: ['owner'],
      suspended: false,
      suspensions: [],
    });
    assert.equal(result.conclusion, 'success');
    assert.match(result.summary, /Approved by gardener, a delegate\./);
    assert.match(result.summary, /pipeline:approval role=delegate login=gardener/);
  } finally {
    file.cleanup();
  }
});

test("the guard's copy reads a null since or id as absent", () => {
  const config = (grant) => ({ admins: ['owner'], delegates: [{ login: 'gardener', approve: true, ...grant }] });
  assert.equal(grantCovers(config({ since: null, id: null }), 'gardener', ['approve']), true);
  assert.equal(grantCovers(config({ since: 'soon' }), 'gardener', ['approve']), false);
  assert.equal(grantCovers(config({ id: 42 }), 'gardener', ['approve'], 7), false);
});

const prWait = fileURLToPath(new URL('../template/.claude/skills/babysit-pr/scripts/pr-wait', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

test("pr-wait's copy reads a null since or id as absent", { skip: !python && 'python not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-wait-idempotent'));
  try {
    writeFileSync(join(dir, 'pipeline.config.json'), JSON.stringify({ admins: ['owner'], delegates: [{ login: 'kept', since: null, id: null }, { login: 'dropped', since: 'soon' }] }));
    const code = [
      'import importlib.machinery, importlib.util, json',
      `loader = importlib.machinery.SourceFileLoader("prwait", ${JSON.stringify(prWait)})`,
      'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("prwait", loader))',
      'loader.exec_module(mod)',
      'print(json.dumps(sorted(mod.DELEGATES)))',
    ].join('\n');
    const out = spawnSync(python, ['-c', code], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), ['kept']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
