// Fast checks that don't need a browser or a build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the app keeps its permissions narrow', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  assert.deepEqual(capability.permissions, ['core:default']);
});
