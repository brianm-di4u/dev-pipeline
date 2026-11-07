#!/usr/bin/env node
// Checks that the restricted agent token can do an agent's job, and can't do the
// things that would let it escape the gate. Run it with the agent token active:
//
//   $env:GH_CONFIG_DIR = "$HOME\.config\gh-agent"
//   node tests/e2e/agent-token.mjs <sandbox-clone-dir>
//
// See docs/AGENT-TOKEN.md. This opens and closes a real PR in the sandbox.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const run = (command, args, input) => spawnSync(command, args, { cwd: dir, encoding: 'utf8', input });
const gh = (...args) => run('gh', args);
const git = (...args) => run('git', args);
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').stdout.trim();

const results = [];
const check = (name, passed, detail = '') => {
  results.push(passed);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const firstLine = (text) => text.trim().split('\n')[0] ?? '';

const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(gh('api', '-i', 'user').stdout)?.[1]?.trim();
check('gh is not using a broad token', !scopes || !/\brepo\b/.test(scopes), scopes ? `scopes: ${scopes}` : 'fine-grained');

// What it must not be able to do.
const protection = gh(
  'api', '-X', 'DELETE', `repos/${repo}/branches/main/protection`,
);
check('It cannot remove branch protection', protection.status !== 0, firstLine(protection.stderr));

const settings = run('gh', ['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], '{"allow_auto_merge":false}');
check('It cannot change repo settings', settings.status !== 0, firstLine(settings.stderr));

const stamp = Date.now();
git('checkout', '-q', 'main');
git('pull', '-q', '--ff-only', 'origin', 'main');
git('checkout', '-q', '-b', `e2e/token-workflow-${stamp}`);
mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
writeFileSync(join(dir, '.github', 'workflows', 'sneaky.yml'), 'name: sneaky\non: push\njobs: {}\n');
git('add', '-A');
git('commit', '-q', '-m', 'Try to add a workflow');
const pushWorkflow = git('push', 'origin', 'HEAD');
check('It cannot push a workflow change', pushWorkflow.status !== 0, firstLine(pushWorkflow.stderr));
git('checkout', '-q', 'main');

// What it must be able to do.
git('checkout', '-q', '-b', `e2e/token-normal-${stamp}`);
writeFileSync(join(dir, `docs-token-${stamp}.md`), '# Token check\n');
git('add', '-A');
git('commit', '-q', '-m', 'Token check');
const push = git('push', '-u', 'origin', 'HEAD');
check('It can push a feature branch', push.status === 0, firstLine(push.stderr));

const created = gh('pr', 'create', '--title', 'Token check', '--body', 'A disposable check of the agent token.');
check('It can open a PR', created.status === 0, firstLine(created.stderr));
const number = created.stdout.trim().split('/').pop();

const sha = git('rev-parse', 'HEAD').stdout.trim();
const forgedCheck = run(
  'gh',
  ['api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'],
  JSON.stringify({ name: 'pipeline/gate', head_sha: sha, status: 'completed', conclusion: 'success' }),
);
check('It cannot forge the gate check', forgedCheck.status !== 0, firstLine(forgedCheck.stderr));

const forgedStatus = gh('api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', 'state=success', '-f', 'context=pipeline/gate');
check('It cannot post a commit status', forgedStatus.status !== 0, firstLine(forgedStatus.stderr));

const merged = gh('pr', 'merge', number, '--squash', '--admin');
check('--admin cannot merge a red gate', merged.status !== 0, firstLine(merged.stderr));

const auto = gh('pr', 'merge', number, '--auto', '--squash');
check('It can enable auto-merge', auto.status === 0, firstLine(auto.stderr));

const comment = gh('pr', 'comment', number, '--body', 'Token check comment.');
check('It can comment', comment.status === 0, firstLine(comment.stderr));

gh('pr', 'close', number, '--delete-branch');
git('checkout', '-q', 'main');
git('branch', '-qD', `e2e/token-workflow-${stamp}`);
git('branch', '-qD', `e2e/token-normal-${stamp}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
