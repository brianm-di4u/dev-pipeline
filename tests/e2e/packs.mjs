#!/usr/bin/env node
// Scaffolds each stack pack into a clean directory and runs its real verification:
// installs, builds, tests, and screenshots. Slow, and needs each stack's toolchain.
//
//   node tests/e2e/packs.mjs [pack ...]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'bin', 'pipeline.mjs');
const wanted = process.argv.slice(2);
const packs = readdirSync(join(root, 'packs')).filter((p) => (wanted.length ? wanted.includes(p) : p !== 'generic'));

const SETUP = {
  'browser-game': 'cd shared/test-harness && npm ci --ignore-scripts && npx playwright install chromium',
  'web-wasm-rust': 'cd shared/test-harness && npm ci --ignore-scripts && npx playwright install chromium',
  'desktop-mobile': 'cd shared/test-harness && npm ci --ignore-scripts && npx playwright install chromium',
  'node-ts': 'npm ci --ignore-scripts && npx playwright install chromium',
};

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Pack Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Pack Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const results = [];
for (const pack of packs) {
  const parent = mkdtempSync(join(tmpdir(), 'pack test '));
  const dir = join(parent, `Sample ${pack}`);
  const started = Date.now();
  const report = { pack, ok: false };
  try {
    execFileSync('node', [cli, 'init', dir, '--pack', pack, '--no-github', '--admin', 'owner'], { env, stdio: 'pipe' });
    const setup = SETUP[pack];
    if (setup) {
      const installed = spawnSync(setup, { cwd: dir, shell: true, env, encoding: 'utf8' });
      if (installed.status !== 0) throw new Error(`setup failed: ${installed.stderr.slice(-800)}`);
    }
    const run = spawnSync('node', ['.pipeline/verify.mjs', 'full'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 1 << 28 });
    report.ok = run.status === 0;
    report.tail = `${run.stdout}${run.stderr}`.split('\n').slice(-14).join('\n');
    const evidenceRoot = join(dir, '.pipeline', 'evidence');
    const [evidence] = readdirSync(evidenceRoot);
    const recorded = JSON.parse(readFileSync(join(evidenceRoot, evidence, 'full.json'), 'utf8'));
    report.commands = recorded.results.map((r) => `${r.exit === 0 ? 'ok  ' : 'FAIL'} ${Math.round(r.ms / 1000)}s  ${r.command}`);
  } catch (error) {
    report.error = error.message;
  }
  report.seconds = Math.round((Date.now() - started) / 1000);
  results.push(report);
  console.log(`\n=== ${pack}: ${report.ok ? 'PASS' : 'FAIL'} in ${report.seconds}s`);
  for (const line of report.commands ?? []) console.log(`  ${line}`);
  if (!report.ok) console.log(report.error ?? report.tail);
  try {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows sometimes holds a lock on a build folder briefly. It's a temp dir.
  }
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
