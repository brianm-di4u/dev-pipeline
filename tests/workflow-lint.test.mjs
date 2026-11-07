// Rules that must stay true of every workflow the template ships. Red-team
// finding: a gate workflow that checks out PR code, or a workflow that puts event
// text into a shell, breaks the whole security model.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function workflows() {
  const dirs = [join(root, 'template/.github/workflows')];
  for (const pack of readdirSync(join(root, 'packs'))) {
    const dir = join(root, 'packs', pack, 'overlay/.github/workflows');
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({ name, path: join(dir, name), text: readFileSync(join(dir, name), 'utf8') })),
  );
}

const packSteps = readdirSync(join(root, 'packs'))
  .map((pack) => join(root, 'packs', pack, 'pack.json'))
  .filter(existsSync)
  .map((path) => ({ path, pack: JSON.parse(readFileSync(path, 'utf8')) }));

test('every action is pinned to a full commit SHA', () => {
  for (const { name, text } of workflows()) {
    for (const [, ref] of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${name}: ${ref}`);
    }
  }
  for (const { path, pack } of packSteps) {
    for (const step of pack.ci?.setup ?? []) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}(\s|$)/, `${path}: ${step.uses}`);
    }
  }
});

test('pull_request_target, issue_comment, and workflow_run workflows never check out PR code', () => {
  for (const { name, text } of workflows()) {
    if (!/pull_request_target|issue_comment|workflow_run/.test(text)) continue;
    assert.doesNotMatch(text, /github\.head_ref/, name);
    assert.doesNotMatch(text, /(pull_request|workflow_run)\.head\.(sha|ref)/, name);
    assert.doesNotMatch(text, /refs\/pull\//, name);
    for (const [, ref] of text.matchAll(/^\s*ref:\s*(.+)$/gm)) {
      assert.match(ref, /default_branch/, `${name}: checkout ref ${ref}`);
    }
  }
});

test('no workflow interpolates attacker-controlled event text', () => {
  const dangerous =
    /\$\{\{[^}]*(\.body|\.title|\.head_ref|head_commit\.message|\.label\.name|\.description|\.head\.ref|\.head_branch|\.ref_name)[^}]*\}\}/;
  for (const { name, text } of workflows()) {
    assert.doesNotMatch(text, dangerous, name);
  }
});

test('every workflow sets least-privilege permissions at the top level', () => {
  for (const { name, text } of workflows()) {
    assert.match(text, /^permissions:/m, name);
    assert.doesNotMatch(text, /permissions:\s*write-all/, name);
  }
});

test('checkout never leaves credentials behind', () => {
  for (const { name, text } of workflows()) {
    const steps = text.split(/^\s*- /m).filter((step) => step.includes('actions/checkout@'));
    for (const step of steps) assert.match(step, /persist-credentials:\s*false/, name);
  }
});

test('no workflow uses secrets: CI has nothing to steal', () => {
  for (const { name, text } of workflows()) {
    assert.doesNotMatch(text, /\bsecrets\.(?!GITHUB_TOKEN)[A-Za-z_]/, name);
  }
});

test('the gate is required to run from the default branch', () => {
  const gate = readFileSync(join(root, 'template/.github/workflows/gate.yml'), 'utf8');
  assert.match(gate, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(gate, /^\s*pull_request:/m);
  assert.match(gate, /checks:\s*write/);
});

test('verify is not gated by anything that lets a skip read as success', () => {
  const ci = readFileSync(join(root, 'template/.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^\s*verify:/m);
  assert.doesNotMatch(ci, /^\s*paths(-ignore)?:/m);
});
