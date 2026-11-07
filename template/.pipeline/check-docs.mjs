#!/usr/bin/env node
// Instruction files that have stopped being true mislead every agent that reads
// them. This fails when CLAUDE.md or REVIEW.md points at a file that no longer exists.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function citedPaths(markdown) {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const paths = new Set();
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(target)) paths.add(target);
  }
  for (const [, target] of text.matchAll(/^@(\S+)$/gm)) paths.add(target);
  for (const [, target] of text.matchAll(/`node (\.?[\w./-]+\.m?js)\b/g)) paths.add(target);
  return [...paths];
}

export function missingPaths(file, markdown, exists = existsSync) {
  return citedPaths(markdown).filter((path) => !exists(join(dirname(file), path)));
}

function main() {
  const problems = ['CLAUDE.md', 'REVIEW.md'].flatMap((file) =>
    existsSync(file) ? missingPaths(file, readFileSync(file, 'utf8')).map((path) => `${file} cites ${path}`) : [],
  );
  if (problems.length > 0) {
    console.error(`Instruction files are out of date:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log('Instruction files cite only paths that exist.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
