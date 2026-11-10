// Releases are the owner's: every job in every release workflow the template
// ships runs only for the repository owner, including on a re-run.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const files = ['template/.github/workflows/release.yml', 'packs/gis-workbench/overlay/.github/workflows/release.yml'].filter((path) =>
  existsSync(new URL(`../${path}`, import.meta.url)),
);

function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  return body.split(/^(?=  [A-Za-z0-9_-]+:\s*$)/m).filter((block) => /^  [A-Za-z0-9_-]+:/.test(block));
}

for (const path of files) {
  test(`every job in ${path} runs only for the owner`, () => {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const list = jobs(text);
    assert.ok(list.length > 0);
    for (const job of list) {
      const name = job.split(':')[0].trim();
      const condition = /^    if:\s*(.+)$/m.exec(job)?.[1] ?? '';
      assert.match(condition, /github\.actor == github\.repository_owner/, `${name} checks the actor`);
      assert.match(condition, /github\.triggering_actor == github\.repository_owner/, `${name} checks who re-ran it`);
    }
  });
}
