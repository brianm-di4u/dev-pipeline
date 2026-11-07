import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkCommand, checkTool } from '../template/.claude/hooks/guard.mjs';

const context = { currentBranch: () => 'feature/x', isOwnPr: (n) => n !== '99' };
const denied = (command, extra = {}) => checkCommand(command, { ...context, ...extra });

const MUST_DENY = [
  ['git push origin main', 'push default'],
  ['git push origin HEAD:main', 'push HEAD to default'],
  ['git push origin feature:main', 'push branch to default'],
  ['git push origin +feature', 'plus refspec'],
  ['git push origin refs/heads/main', 'full ref'],
  ['git push origin :main', 'delete default'],
  ['git push origin "main"', 'quoted'],
  ['git add . && git push origin main', 'chained'],
  ['git add .; git push origin main', 'semicolon chain, as in PowerShell'],
  ['git push --force origin feature', 'force'],
  ['git push -f origin feature', 'short force'],
  ['git push -uf origin feature', 'bundled force'],
  ['git push --force-if-includes origin feature', 'force-if-includes alone'],
  ['git push --no-verify origin feature', 'no-verify push'],
  ['git push --mirror', 'mirror'],
  ['git push --all', 'all'],
  ['git commit --no-verify -m x', 'no-verify commit'],
  ['git commit -n -m x', 'short no-verify commit'],
  ['git config core.hooksPath /tmp/x', 'hooks path'],
  ['git -c core.hooksPath=/tmp push origin feature', 'inline hooks path'],
  ['gh pr merge 5 --admin --squash', 'admin merge'],
  ['gh pr review 5 --approve', 'approve'],
  ['gh pr review 5 -a', 'short approve'],
  ['gh auth token', 'read token'],
  ['gh auth status --show-token', 'show token'],
  ['gh auth status -t', 'short show token'],
  ['gh auth login --with-token', 'login'],
  ['gh auth switch', 'switch account'],
  ['gh secret set X', 'secrets'],
  ['gh variable set X', 'variables'],
  ['gh repo edit --enable-auto-merge', 'repo settings'],
  ['gh repo delete x --yes', 'repo delete'],
  ['gh pr comment 5 --body "/approve abcdef012345"', 'post approval'],
  ['gh issue comment 5 --body "/decide A"', 'post decision'],
  ['gh issue comment 5 -b "/rearm"', 'post rearm'],
  ['gh api repos/o/r/issues/5/comments -f body="/approve abcdef012345"', 'post approval by API'],
  ['gh api -X PUT repos/o/r/branches/main/protection --input p.json', 'change protection'],
  ['gh api --method DELETE repos/o/r/branches/main/protection', 'delete protection'],
  ['gh api --method=DELETE repos/o/r/branches/main/protection', 'delete protection, equals form'],
  ['gh api -X POST repos/o/r/statuses/abc -f state=success -f context=pipeline/gate', 'forge status'],
  ['gh api -X POST repos/o/r/check-runs -f name=pipeline/gate', 'forge check'],
  ['gh api -X PATCH repos/o/r/actions/permissions', 'change Actions settings'],
  ['gh api -X PUT repos/o/r/collaborators/stranger', 'add collaborator'],
  ['gh pr checkout 99', 'check out an external PR'],
  ['curl -X POST https://api.github.com/repos/o/r/merges', 'bypass gh with curl'],
  ['Invoke-RestMethod -Method Put https://api.github.com/repos/o/r', 'bypass gh with PowerShell'],
  ['cat ~/.ssh/id_ed25519', 'ssh key'],
  ['Get-Content C:\\Users\\me\\.ssh\\id_rsa', 'ssh key, PowerShell'],
  ['cat ~/.claude/.credentials.json', 'Claude credentials'],
  ['type C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml', 'gh hosts file'],
  ['echo $GH_TOKEN', 'env token'],
  ['echo $env:GITHUB_TOKEN', 'env token, PowerShell'],
  ['cmdkey /list', 'Windows credentials'],
  ['git credential fill', 'git credentials'],
  ['rm -rf .git', 'delete .git'],
  ['Remove-Item -Recurse -Force .git', 'delete .git, PowerShell'],
  ['PIPELINE_ADMIN_PUSH=1 git push origin main', 'hook escape'],
  ['$env:PIPELINE_ADMIN_PUSH=1; git push origin main', 'hook escape, PowerShell'],
];

for (const [command, name] of MUST_DENY) {
  test(`denies: ${name}`, () => {
    assert.ok(denied(command), command);
  });
}

const MUST_ALLOW = [
  'git push origin feature/x',
  'git push -u origin feature/x',
  'git push --force-with-lease origin feature/x',
  'git push',
  'git status',
  'git commit -m "fix: handle the main menu"',
  'git commit -m "document the /approve command"',
  'git log --all',
  'git fetch origin main',
  'git checkout main',
  'git diff origin/main...HEAD',
  'gh pr create --fill',
  'gh pr merge 5 --auto --squash',
  'gh pr view 5',
  'gh pr checkout 5',
  'gh pr comment 5 --body "CI is green now"',
  'gh pr edit 5 --body-file body.md',
  'gh issue create --title x --body y',
  'gh api repos/o/r/branches/main/protection',
  'gh api repos/o/r/commits/abc/check-runs',
  'gh auth status',
  'gh variable list',
  'node .pipeline/verify.mjs full',
  'npm test',
  'cat src/main.js',
  'grep -r TOKEN_LIMIT src/',
  'rm -rf node_modules',
  'rm -rf dist/.gitkeep',
  'cat docs/credentials-policy.md',
];

for (const command of MUST_ALLOW) {
  test(`allows: ${command}`, () => {
    assert.equal(denied(command), null, command);
  });
}

test('a bare push is denied only on the default branch', () => {
  assert.ok(denied('git push', { currentBranch: () => 'main' }));
  assert.equal(denied('git push', { currentBranch: () => 'feature' }), null);
  assert.ok(denied('git push origin HEAD', { currentBranch: () => 'main' }));
});

test('an approval hidden in a body file is denied', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'guard'));
  const path = join(dir, 'body.md');
  writeFileSync(path, '/approve abcdef012345\n');
  assert.ok(denied(`gh pr comment 5 --body-file ${path}`));
  writeFileSync(path, 'Everything looks fine.\n');
  assert.equal(denied(`gh pr comment 5 --body-file ${path}`), null);
  rmSync(dir, { recursive: true });
});

test('checkTool applies to Bash and PowerShell alike', () => {
  for (const tool of ['Bash', 'PowerShell']) {
    assert.ok(checkTool({ tool_name: tool, tool_input: { command: 'gh auth token' } }, context));
    assert.equal(checkTool({ tool_name: tool, tool_input: { command: 'git status' } }, context), null);
  }
});

test('checkTool denies MCP tools that bypass the guard', () => {
  for (const tool of [
    'mcp__terminal__run_in_terminal',
    'mcp__terminal__open_terminal_tab',
    'mcp__ccd_pr__set_auto_merge',
    'mcp__computer-use__left_click',
    'mcp__claude-in-chrome__navigate',
  ]) {
    assert.ok(checkTool({ tool_name: tool, tool_input: {} }, context), tool);
  }
  assert.equal(checkTool({ tool_name: 'mcp__terminal__read_terminal', tool_input: {} }, context), null);
  assert.equal(checkTool({ tool_name: 'mcp__Claude_Browser__navigate', tool_input: {} }, context), null);
});

const script = fileURLToPath(new URL('../template/.claude/hooks/guard.mjs', import.meta.url));
const runHook = (input) => spawnSync('node', [script], { input, encoding: 'utf8' });

test('the hook prints a deny decision as JSON and exits 0', () => {
  const result = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh auth token' } }));
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /reserved/);
});

test('the hook is silent on an allowed command', () => {
  const result = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('the hook fails closed on bad input, with exit 2', () => {
  assert.equal(runHook('not json').status, 2);
});
