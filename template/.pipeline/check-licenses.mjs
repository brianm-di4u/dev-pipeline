#!/usr/bin/env node
// Dependencies must be under a license on the THIRD_PARTY.md allowlist. A failure
// here is a legal decision for the admin, not something for an agent to work
// around. Checks npm lockfiles directly. Rust projects also run `cargo deny check`.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { git } from './lib/git.mjs';

export function allowlist(thirdParty) {
  const section = /## Allowed licenses\s+([\s\S]*?)(?=\n## )/.exec(thirdParty)?.[1] ?? '';
  const line = section.split('\n').find((l) => /,/.test(l)) ?? '';
  const names = line.replace(/\(.*?\)/g, '').split(',');
  return new Set(names.map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function isAllowed(license, allowed) {
  if (!license) return false;
  // "(MIT OR GPL-3.0)" passes if either side is allowed; "A AND B" needs both.
  const text = String(license).replace(/[()]/g, ' ').trim();
  return text.split(/\s+OR\s+/i).some((option) =>
    option
      .split(/\s+AND\s+/i)
      .every((part) => allowed.has(part.trim().toLowerCase())),
  );
}

export function problems(lockfile, allowed, exceptions = []) {
  const found = [];
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    if (path === '' || !path.includes('node_modules/')) continue;
    const name = path.split('node_modules/').pop();
    if (entry.link || exceptions.includes(name)) continue;
    if (!isAllowed(entry.license, allowed)) found.push({ name, version: entry.version, license: entry.license ?? 'none declared' });
  }
  return found;
}

function main() {
  if (!existsSync('THIRD_PARTY.md')) return 0;
  const allowed = allowlist(readFileSync('THIRD_PARTY.md', 'utf8'));
  const config = JSON.parse(readFileSync('pipeline.config.json', 'utf8'));
  const exceptions = config.licenseExceptions ?? [];
  const locks = git(['ls-files']).split('\n').filter((p) => /(^|\/)package-lock\.json$/.test(p));
  const found = locks.flatMap((path) =>
    problems(JSON.parse(readFileSync(path, 'utf8')), allowed, exceptions).map((p) => ({ ...p, path })),
  );
  if (found.length > 0) {
    console.error('These dependencies are not under an allowed license. This needs a legal decision (use the decision skill):');
    for (const p of found) console.error(`  ${p.name}@${p.version}: ${p.license} (${p.path})`);
    return 1;
  }
  console.log(`Dependency licenses are on the allowlist (${locks.length} lockfiles).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
