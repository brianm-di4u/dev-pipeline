import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPersonas, parseAgentFile } from '../template/.pipeline/lib/personas.mjs';
import { selectSeats } from '../template/.pipeline/lib/ledger.mjs';

const dir = fileURLToPath(new URL('../template/.claude/agents', import.meta.url));
const files = readdirSync(dir);
const agents = files.map((name) => parseAgentFile(readFileSync(`${dir}/${name}`, 'utf8')));

test('every seat is defined, with a model alias rather than a pinned ID', () => {
  assert.equal(agents.length, 9);
  for (const agent of agents) {
    assert.match(agent.name, /^council-/);
    assert.ok(['opus', 'sonnet'].includes(agent.model), `${agent.name}: ${agent.model}`);
    assert.ok(agent.body.length > 100, agent.name);
  }
});

test('every seat is denied editing and spawning, and has a turn limit', () => {
  for (const name of files) {
    const text = readFileSync(`${dir}/${name}`, 'utf8');
    assert.match(text, /^disallowedTools:.*\bEdit\b.*\bWrite\b.*\bAgent\b/m, name);
    assert.match(text, /^maxTurns:\s*\d+/m, name);
  }
});

test('every seat that selectSeats can name has a definition', () => {
  const available = new Set(agents.map((a) => a.name));
  const selection = selectSeats({
    tier: 2,
    paths: ['src/app.tsx', 'package.json', 'src/x.ts'],
    council: { maxSeats: 99 },
  });
  for (const seat of selection.seats) assert.ok(available.has(seat.agent), seat.agent);
  assert.ok(available.has('council-verifier'));
});

test('no seat text still has a template token', () => {
  for (const name of files) assert.doesNotMatch(readFileSync(`${dir}/${name}`, 'utf8'), /\{\{/, name);
});

test('personas load from a directory, and a missing one is empty', () => {
  const personas = loadPersonas(dir);
  assert.equal(Object.keys(personas).length, 9);
  assert.equal(personas['council-security-auditor'].model, 'opus');
  assert.deepEqual(loadPersonas(`${dir}/does-not-exist`), {});
});
