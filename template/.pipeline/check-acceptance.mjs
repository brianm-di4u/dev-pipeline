#!/usr/bin/env node
// Every acceptance criterion in docs/PRD.md must be named by a test. A criterion
// counts once it has real text: the blank one in a new project's PRD doesn't.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { git } from './lib/git.mjs';
import { matchesAny } from './lib/paths.mjs';

const DEFAULT_TEST_PATHS = ['tests/**', 'tests-node/**', 'e2e/**', '**/*.test.*', '**/*.spec.*', '**/tests/**', 'crates/**/*.rs', 'src/**/*.rs'];

export function criteria(prd) {
  const text = prd.replace(/<!--[\s\S]*?-->/g, '');
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /\bAC-(\d+)\b\W*(.*)$/.exec(line);
    if (match && match[2].trim()) found.add(`AC-${match[1]}`);
  }
  return [...found].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

export function uncovered(ids, testText) {
  return ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(testText));
}

function main() {
  if (!existsSync('docs/PRD.md')) return 0;
  const ids = criteria(readFileSync('docs/PRD.md', 'utf8'));
  if (ids.length === 0) {
    console.log('No acceptance criteria yet.');
    return 0;
  }
  const config = JSON.parse(readFileSync('pipeline.config.json', 'utf8'));
  const paths = git(['ls-files']).split('\n').filter((p) => p && matchesAny(p, config.acceptance?.testPaths ?? DEFAULT_TEST_PATHS));
  const testText = paths.map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')).join('\n');
  const missing = uncovered(ids, testText);
  if (missing.length > 0) {
    console.error(`No test names these acceptance criteria: ${missing.join(', ')}`);
    return 1;
  }
  console.log(`${ids.length} acceptance criteria covered.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
