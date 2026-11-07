import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from './greet.ts';

test('greets by name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('falls back when there is no name', () => {
  assert.equal(greet(null), 'Hello, world!');
  assert.equal(greet('   '), 'Hello, world!');
});
