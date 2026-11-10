// The guard judges a command word as GitHub receives it: through Git Bash on
// Windows, through PowerShell, and through gh's own option parsing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTool } from '../template/.claude/hooks/guard.mjs';

const base = { currentBranch: () => 'feature/x', isOwnPr: () => true };
// No delegates anywhere, so nothing is looked up.
const nobody = { ...base, delegateMayPost: () => false, isDelegateSession: () => false, localDelegates: () => false };
// A worker in a repo with delegates: the owner's login, so not a delegate.
const worker = { ...base, delegateMayPost: () => false, isDelegateSession: () => false, localDelegates: () => true };
const delegate = { ...base, delegateMayPost: () => true, isDelegateSession: () => true, localDelegates: () => true };

const run = (tool, command, context, platform = 'win32') => checkTool({ tool_name: tool, tool_input: { command } }, { ...context, platform });

const BASH = [
  'gh pr comment 5 --body "//approve abcdef012345"',
  'gh pr comment 5 --body "///approve abcdef012345"',
  "gh pr comment 5 --body '//approve abcdef012345'",
  'gh pr comment 5 --body=//approve',
  'gh pr comment 5 -b//approve',
  'gh pr comment 5 -b/approve',
  'gh pr comment 5 -b=//approve',
  'gh issue comment 5 --body "//rearm"',
  'gh issue comment 5 -b "//decide A"',
  'gh api repos/o/r/issues/5/comments -f body=//approve',
  'gh api repos/o/r/issues/5/comments -f "body=//approve abcdef012345"',
];
const POWERSHELL = [
  'gh pr comment 5 --body "//approve abcdef012345"',
  "gh pr comment 5 --body '//approve abcdef012345'",
  "gh pr comment 5 --body ('//approve abcdef012345')",
  'gh pr comment 5 -b//approve',
  'gh issue comment 5 --body "//rearm"',
  'gh api repos/o/r/issues/5/comments -f "body=//approve abcdef012345"',
];

test('a command word behind a run of slashes, or attached to a one-letter option, is denied in Bash', () => {
  for (const command of BASH) {
    for (const platform of ['win32', 'linux']) {
      assert.match(run('Bash', command, nobody, platform) ?? '', /Only a human posts/, `${platform}: ${command}`);
      assert.match(run('Bash', command, worker, platform) ?? '', /Only a human posts/, `${platform}: ${command}`);
    }
  }
});

test('the same forms are denied in PowerShell', () => {
  for (const command of POWERSHELL) {
    assert.match(run('PowerShell', command, nobody) ?? '', /Only a human posts/, command);
    assert.match(run('PowerShell', command, worker) ?? '', /Only a human posts/, command);
  }
});

test('text that only mentions a command, or has a slash inside a word, is still allowed', () => {
  for (const command of [
    'gh pr comment 5 --body "the approve command is next"',
    'gh pr comment 5 --body "see src//approve.js"',
    'gh pr comment 5 --body "moved a/approve to b"',
    'gh pr comment 5 --body "https://example.com//approve"',
    'gh pr create --title x --body "-x approve"',
    'git commit -m "document //approve"',
  ]) {
    assert.equal(run('Bash', command, nobody), null, command);
    assert.equal(run('PowerShell', command, nobody), null, command);
  }
});

test("a delegate's command is denied in Git Bash on Windows, and allowed in PowerShell", () => {
  for (const command of ['gh pr comment 5 --body "/approve abcdef012345"', 'gh issue comment 5 --body "/decide A"', 'gh issue comment 5 -b "/rearm"']) {
    assert.match(run('Bash', command, delegate) ?? '', /Git Bash on Windows rewrites a leading slash.*PowerShell tool/, command);
    assert.equal(run('PowerShell', command, delegate), null, command);
    // Bash elsewhere passes the slash on unchanged.
    assert.equal(run('Bash', command, delegate, 'linux'), null, command);
    assert.equal(run('Bash', command, delegate, 'darwin'), null, command);
  }
});

test('a session that is not a delegate gets the usual denial in Git Bash, not the PowerShell hint', () => {
  const command = 'gh pr comment 5 --body "/approve abcdef012345"';
  assert.match(run('Bash', command, worker), /^Only a human posts/);
  assert.match(run('Bash', command, nobody), /^Only a human posts/);
  assert.match(run('PowerShell', command, worker), /^Only a human posts/);
});
