// The delegate work in post-merge, audit and decisions runs in jobs of its own,
// so the jobs every adopter already has keep today's permissions, and the new
// jobs do nothing unless a delegate is configured.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function job(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `no ${name} job`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n|\n {2}#/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

const permissions = (block) =>
  Object.fromEntries([...(/\n {4}permissions:\n((?: {6}[a-z-]+: \w+\n)+)/.exec(block)?.[1] ?? '').matchAll(/ {6}([a-z-]+): (\w+)/g)].map((m) => [m[1], m[2]]));

const FILES = [
  ['template/.github/workflows/post-merge.yml', 'record', { contents: 'read', issues: 'write', 'pull-requests': 'read' }, 'delegates-post-merge'],
  ['packs/desktop-mobile/overlay/.github/workflows/post-merge.yml', 'record', { contents: 'read', issues: 'write', 'pull-requests': 'read' }, 'delegates-post-merge'],
  ['packs/gis-workbench/overlay/.github/workflows/post-merge.yml', 'record', { contents: 'read', issues: 'write', 'pull-requests': 'read' }, 'delegates-post-merge'],
  ['template/.github/workflows/audit.yml', 'audit', { contents: 'read', issues: 'write', 'pull-requests': 'read' }, 'delegates-audit'],
  ['template/.github/workflows/decisions.yml', 'handle', { contents: 'read', issues: 'write' }, 'delegates-lifted'],
];

for (const [path, existing, today, command] of FILES) {
  test(`${path}: the ${existing} job keeps today's permissions and shallow checkout`, () => {
    const block = job(read(path), existing);
    assert.deepEqual(permissions(block), today);
    assert.doesNotMatch(block, /fetch-depth|checks: write|actions: read|delegates-/);
  });

  test(`${path}: the delegates job stops first when no delegate is configured`, () => {
    const block = job(read(path), 'delegates');
    assert.match(block, /checks: write/);
    const steps = block.split(/\n {6}- /).slice(1);
    assert.match(steps[0], /actions\/checkout@/);
    assert.match(steps[1], /id: delegates[\s\S]*Array\.isArray\(c\.delegates\)/);
    for (const step of steps.slice(2)) assert.match(step, /if: \$\{\{ steps\.delegates\.outputs\.on == 'true' \}\}/, step);
    assert.match(block, new RegExp(`monitor\\.mjs ${command}`));
  });
}
