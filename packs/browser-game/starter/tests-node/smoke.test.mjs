// Fast checks that don't need a browser: rules, solvers, and data checks go here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the page declares the test contract', () => {
  assert.match(readFileSync('index.html', 'utf8'), /window\.__game\s*=/);
});
