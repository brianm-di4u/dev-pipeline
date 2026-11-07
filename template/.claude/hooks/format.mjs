#!/usr/bin/env node
// PostToolUse formatter. Runs the formatter set for this file's extension in
// pipeline.config.json. Formatting must never block work, so failures are ignored
// here and caught later by verify.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

let text = '';
for await (const chunk of process.stdin) text += chunk;

try {
  const file = JSON.parse(text).tool_input?.file_path;
  const formatters = JSON.parse(readFileSync('pipeline.config.json', 'utf8')).formatters ?? {};
  const command = file ? formatters[extname(file).toLowerCase()] : null;
  if (command) spawnSync(`${command} "${file}"`, { shell: true, stdio: 'ignore', timeout: 30000 });
} catch {
  // Nothing to format.
}
