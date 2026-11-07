#!/usr/bin/env node
// PreToolUse guard for shell and MCP tools. It stops accidents, not a determined
// bypass: it is a pattern match, and a script written to disk can evade it. The
// restricted agent token is what limits the damage from a bypass.
//
// settings.json runs this with onFailure: "block", so a crash denies the call.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_BRANCHES = new Set(['main', 'master']);

const DENIED_TOOLS = [
  [/^mcp__terminal__(run_in_terminal|open_terminal_tab)$/, 'runs commands outside this guard'],
  [/^mcp__ccd_pr__set_auto_merge$/, 'merges outside the gate; use the full-send skill'],
  [/^mcp__computer-use__/, 'can operate GitHub as the owner, outside this guard'],
  [/^mcp__claude-in-chrome__/, "acts in the owner's signed-in browser, outside this guard"],
];

const CREDENTIAL_PATTERN =
  /\.credentials\.json|[\\/]\.ssh[\\/]|hosts\.yml|\.netrc|[\\/]\.aws[\\/]credentials|\bcmdkey\b|\bvaultcmd\b|credentialmanager|git\s+credential\s+fill|\b(GH|GITHUB)_TOKEN\b/i;

const PROTECTED_API =
  /(^|\/)(branches\/[^/\s]+\/protection|rulesets|collaborators|keys|hooks|actions\/secrets|actions\/variables|actions\/permissions|environments|check-runs|statuses|vulnerability-alerts|code-scanning\/default-setup)\b/i;

const COMMAND_WORD = /(^|[\s"'=`])\/(approve|decide|rearm)\b/;

const ADMIN_ESCAPE = /\bPIPELINE_ADMIN_PUSH\b/;

function tokenize(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function checkPush(args, context) {
  for (const arg of args) {
    if (arg === '--force' || arg === '--force-if-includes' || /^-[a-z]*f[a-z]*$/i.test(arg) || arg.startsWith('+')) {
      return 'Force pushes must use --force-with-lease on a feature branch.';
    }
    if (arg === '--no-verify') return '--no-verify skips the pre-push check.';
    if (arg === '--mirror' || arg === '--all') return `git push ${arg} can overwrite the default branch.`;
  }

  const positional = args.filter((arg) => !arg.startsWith('-'));
  const refspecs = positional.slice(1);
  const branch = () => context.currentBranch(context.cwd);
  if (refspecs.length === 0) {
    if (DEFAULT_BRANCHES.has(branch())) return 'This would push to the default branch. Open a PR instead.';
    return null;
  }
  for (const refspec of refspecs) {
    const destination = refspec.split(':').pop().replace(/^refs\/heads\//, '');
    const resolved = destination === 'HEAD' ? branch() : destination;
    if (DEFAULT_BRANCHES.has(resolved)) return 'This would push to the default branch. Open a PR instead.';
  }
  return null;
}

function checkGit(tokens, context) {
  const raw = tokens.join(' ');
  if (/core\.hookspath/i.test(raw)) return 'Changing core.hooksPath would disable or replace git hooks.';
  const subcommand = tokens.findIndex((token, i) => i > 0 && !token.startsWith('-') && tokens[i - 1] !== '-c' && tokens[i - 1] !== '-C');
  if (subcommand === -1) return null;
  const name = tokens[subcommand];
  const args = tokens.slice(subcommand + 1);
  if (name === 'push') return checkPush(args, context);
  if (name === 'commit' && args.some((arg) => arg === '--no-verify' || arg === '-n')) {
    return 'git commit --no-verify skips commit hooks.';
  }
  return null;
}

function bodyFileText(tokens, cwd) {
  const index = tokens.findIndex((token) => token === '--body-file' || token === '-F');
  if (index === -1) return '';
  const path = tokens[index + 1];
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function checkGh(tokens, segment, context) {
  const [, group, action] = tokens;
  const args = tokens.slice(2);

  if (group === 'auth') {
    if (['token', 'login', 'logout', 'refresh', 'setup-git', 'switch'].includes(action)) {
      return `gh auth ${action} is reserved for the owner.`;
    }
    if (args.includes('--show-token') || args.includes('-t')) return 'Agents must not read auth tokens.';
  }
  if (group === 'secret') return 'gh secret is reserved for the owner.';
  if (group === 'variable' && action !== 'list' && action !== 'get') return 'gh variable changes are reserved for the owner.';
  if (group === 'ruleset' && action !== 'list' && action !== 'view' && action !== 'check') return 'Rulesets are reserved for the owner.';
  if (group === 'repo' && ['edit', 'delete', 'rename', 'archive', 'unarchive'].includes(action)) {
    return `gh repo ${action} is reserved for the owner.`;
  }
  if (group === 'pr' && action === 'merge' && args.includes('--admin')) return '--admin bypasses the gate.';
  if (group === 'pr' && action === 'review' && (args.includes('--approve') || args.includes('-a'))) {
    return 'Agents cannot approve PRs. Approval belongs to a human.';
  }
  if (group === 'pr' && action === 'checkout') {
    const number = tokens.slice(3).find((arg) => !arg.startsWith('-'));
    if (!context.isOwnPr(number)) {
      return 'Never check out an external PR: its .claude/ hooks and git hooks would run here. Review it by API diff.';
    }
  }

  const posts =
    ((group === 'issue' || group === 'pr') && (action === 'comment' || action === 'review' || action === 'create' || action === 'edit')) ||
    group === 'api';
  if (posts) {
    const text = `${segment}\n${bodyFileText(tokens, context.cwd)}`;
    if (COMMAND_WORD.test(text)) {
      return 'Only a human posts /approve, /decide, or /rearm. Reword it, for example "the approve command".';
    }
  }

  if (group === 'api') {
    const mutates =
      args.some((arg, i) => (arg === '-X' || arg === '--method') && !/^get$/i.test(args[i + 1] ?? '')) ||
      args.some((arg) => /^--method=(?!get$)/i.test(arg)) ||
      args.some((arg) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg));
    const path = args.find((arg) => !arg.startsWith('-') && /\//.test(arg)) ?? action ?? '';
    if (mutates && PROTECTED_API.test(path)) return `Changing ${path} is reserved for the owner.`;
  }
  return null;
}

export function checkCommand(command, context = {}) {
  const ctx = {
    cwd: process.cwd(),
    currentBranch,
    isOwnPr: defaultIsOwnPr,
    ...context,
  };
  if (CREDENTIAL_PATTERN.test(command)) return 'This touches credentials, which agents must not read.';
  if (ADMIN_ESCAPE.test(command)) return 'PIPELINE_ADMIN_PUSH is reserved for the owner.';
  if (/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|;&\n]*api\.github\.com/i.test(command)) {
    return 'Use gh for GitHub API calls, so this guard can see them.';
  }
  if (/\b(rm|del|rd|rmdir|remove-item)\b[^|;&\n]*(^|[\s"'\\/])\.git(["'\s\\/]|$)/i.test(command)) {
    return 'Deleting .git is not allowed.';
  }

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = tokenize(segment.trim());
    const start = tokens.findIndex((token) => /^(git|gh)(\.exe)?$/i.test(token));
    if (start === -1) continue;
    const tool = tokens[start].toLowerCase().replace('.exe', '');
    const rest = tokens.slice(start);
    const reason = tool === 'git' ? checkGit(rest, ctx) : checkGh(rest, segment, ctx);
    if (reason) return reason;
  }
  return null;
}

function defaultIsOwnPr(number) {
  try {
    const args = ['pr', 'view', ...(number ? [number] : []), '--json', 'isCrossRepository', '--jq', '.isCrossRepository'];
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'false';
  } catch {
    return false;
  }
}

export function checkTool({ tool_name: tool, tool_input: input = {}, cwd }, context = {}) {
  for (const [pattern, why] of DENIED_TOOLS) {
    if (pattern.test(tool ?? '')) return `${tool} ${why}.`;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    return checkCommand(input.command ?? '', { cwd, ...context });
  }
  return null;
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const reason = checkTool(JSON.parse(text));
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Guard failed: ${error.message}`);
    process.exitCode = 2;
  });
}
