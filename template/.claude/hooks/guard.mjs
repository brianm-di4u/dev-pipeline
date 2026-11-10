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

// With a delegate configured, settings.local.json can hold its token. See
// docs/AGENT-TOKEN.md in dev-pipeline.
const LOCAL_SETTINGS = /settings\.local\.json/i;

const PROTECTED_API =
  /(^|\/)(branches\/[^/\s]+\/protection|rulesets|collaborators|keys|hooks|actions\/secrets|actions\/variables|actions\/permissions|environments|check-runs|statuses|vulnerability-alerts|code-scanning\/default-setup)\b/i;

// Release writes, denied in a delegate's own session. A numeric workflow id could
// be the release workflow, so a delegate can't dispatch by id at all.
const RELEASE_API = /(^|\/)(releases\b|actions\/workflows\/([^/\s]*release[^/\s]*|\d+)\/dispatches\b)/i;

// In a delegate's session, a command word may only go out as one plain comment
// command: nothing chained or piped, no subshell, and nothing that changes the
// environment or credentials first. Otherwise a command could drop the session's
// token, and gh would fall back to the owner's login and post as the admin.
const PLAIN_COMMENT = /^gh(?:\.exe)?\s+(?:issue|pr)\s+comment\s/i;
const SHELL_META = /[;&|`$<>()\r\n]/;

// The repo a gh command names, from --repo or -R, or from an issue or PR URL, or
// null when it means the working directory's own repo. GH_REPO in the
// environment also counts.
export function targetRepo(tokens, env = process.env) {
  const flag = tokens.findIndex((token) => token === '--repo' || token === '-R');
  if (flag !== -1 && tokens[flag + 1]) return tokens[flag + 1].replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  const inline = tokens.find((token) => /^--repo=/.test(token));
  if (inline) return inline.slice('--repo='.length);
  const url = tokens.map((token) => /github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/\d+/i.exec(token)).find(Boolean);
  if (url) return url[1];
  return env.GH_REPO || null;
}

export function plainComment(command) {
  const text = (command ?? '').trim();
  return PLAIN_COMMENT.test(text) && !SHELL_META.test(text);
}

const COMMAND_WORD = /(^|[\s"'=`])\/(approve|decide|rearm)\b/;
const COMMAND_WORDS = /(?:^|[\s"'=`])\/(approve|decide|rearm)\b/g;

const RELEASE_WRITES = ['create', 'edit', 'delete', 'delete-asset', 'upload'];
const DECISION_CLASSES = ['design', 'determination', 'legal', 'security', 'major'];
const LOOKUP_TIMEOUT_MS = 4000;
// As in .pipeline/lib/authority.mjs. The gate checks a command's time against it.
const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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
  // Releases are the owner's. A delegate's own session can't make one.
  const release = releaseWrite(group, action, tokens, args);
  if (release && context.isDelegateSession(context.cwd)) return release;

  const posts =
    ((group === 'issue' || group === 'pr') && (action === 'comment' || action === 'review' || action === 'create' || action === 'edit')) ||
    group === 'api';
  if (posts) {
    const text = `${segment}\n${bodyFileText(tokens, context.cwd)}`;
    if (COMMAND_WORD.test(text)) {
      const words = [...new Set([...text.matchAll(COMMAND_WORDS)].map((match) => match[1]))];
      if (!plainComment(context.command) || !context.delegateMayPost(words, context.cwd, targetRepo(tokens))) {
        return 'Only a human posts /approve, /decide, or /rearm. Reword it, for example "the approve command".';
      }
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

const FLAGS_WITH_VALUES = new Set(['-r', '--ref', '-f', '--raw-field', '-F', '--field', '--json', '-R', '--repo']);

function releaseWrite(group, action, tokens, args) {
  if (group === 'release' && RELEASE_WRITES.includes(action)) return `gh release ${action} is reserved for the owner.`;
  if (group === 'workflow' && action === 'run') {
    // The workflow is the first argument that isn't a flag or a flag's value, so
    // `--ref release/2.6` on another workflow isn't caught.
    const rest = tokens.slice(3);
    const workflow = rest.find((token, i) => !token.startsWith('-') && !FLAGS_WITH_VALUES.has(rest[i - 1]));
    if (workflow && (/release/i.test(workflow) || /^\d+$/.test(workflow))) {
      return 'Running the release workflow is reserved for the owner.';
    }
  }
  if (group === 'api') {
    const mutates =
      args.some((arg, i) => (arg === '-X' || arg === '--method') && !/^get$/i.test(args[i + 1] ?? '')) ||
      args.some((arg) => /^--method=(?!get$)/i.test(arg)) ||
      args.some((arg) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg));
    const path = args.find((arg) => !arg.startsWith('-') && /\//.test(arg)) ?? action ?? '';
    if (mutates && RELEASE_API.test(path)) return `Changing ${path} is reserved for the owner.`;
  }
  return null;
}

export function checkCommand(command, context = {}) {
  const ctx = {
    cwd: process.cwd(),
    currentBranch,
    isOwnPr: defaultIsOwnPr,
    delegateMayPost: defaultDelegateMayPost,
    isDelegateSession: defaultIsDelegateSession,
    localDelegates: defaultLocalDelegates,
    ...context,
    command,
  };
  if (CREDENTIAL_PATTERN.test(command)) return 'This touches credentials, which agents must not read.';
  if (LOCAL_SETTINGS.test(command) && ctx.localDelegates(ctx.cwd)) return 'This touches credentials, which agents must not read.';
  if (ADMIN_ESCAPE.test(command)) return 'PIPELINE_ADMIN_PUSH is reserved for the owner.';
  if (/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|;&\n]*api\.github\.com/i.test(command)) {
    return 'Use gh for GitHub API calls, so this guard can see them.';
  }
  if (/\b(rm|del|rd|rmdir|remove-item)\b[^|;&\n]*(^|[\s"'\\/])\.git(["'\s\\/]|$)/i.test(command)) {
    return 'Deleting .git is not allowed.';
  }

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = tokenize(segment.trim());
    // A call inside $( ), ( ) or backticks, or assigned to a variable, is still a call.
    const start = tokens.findIndex((token) => /^(?:\w+=)?[`$(]*(git|gh)(\.exe)?$/i.test(token));
    if (start === -1) continue;
    const tool = tokens[start].toLowerCase().replace(/^(?:\w+=)?[`$(]+/, '').replace(/^\w+=/, '').replace('.exe', '');
    const rest = [tool, ...tokens.slice(start + 1)];
    const reason = tool === 'git' ? checkGit(rest, ctx) : checkGh(rest, segment, ctx);
    if (reason) return reason;
  }
  return null;
}

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Whether `login`'s grant in `config` covers every command word. It mirrors
// .pipeline/lib/authority.mjs, so the hook needs nothing outside this file: an
// entry the gate would drop grants nothing here either.
export function grantCovers(config, login, words) {
  const admins = Array.isArray(config?.admins) ? config.admins : [];
  if (!login || admins.some((admin) => sameLogin(admin, login))) return false;
  const adminOnly = config.tiers?.adminOnlyPaths;
  if (adminOnly !== undefined && !(Array.isArray(adminOnly) && adminOnly.every((p) => typeof p === 'string'))) return false;
  const grant = (Array.isArray(config?.delegates) ? config.delegates : []).find((entry) => sameLogin(entry?.login, login));
  if (!grant) return false;
  for (const flag of ['approve', 'approveExternal', 'approveWorkflows', 'rearm', 'direct']) {
    if (flag in grant && typeof grant[flag] !== 'boolean') return false;
  }
  const decide = grant.decide ?? [];
  if (!Array.isArray(decide) || !decide.every((cls) => DECISION_CLASSES.includes(cls))) return false;
  if ('since' in grant && !(typeof grant.since === 'string' && SINCE.test(grant.since) && !Number.isNaN(Date.parse(grant.since)))) return false;
  return words.every((word) => (word === 'approve' ? grant.approve === true : word === 'decide' ? decide.length > 0 : grant.rearm === true));
}

const lookup = (args, cwd) =>
  execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Whether the working tree's config names any delegate. It decides only whether
// to look further, never what a session may do.
function defaultLocalDelegates(cwd) {
  try {
    const local = JSON.parse(readFileSync(`${cwd ?? process.cwd()}/pipeline.config.json`, 'utf8'));
    return Array.isArray(local.delegates) && local.delegates.length > 0;
  } catch {
    return false;
  }
}

// Who the session is comes from GitHub (`gh api user`), and the delegates from the
// default branch's config, read through the API, so editing the working tree
// changes nothing. Throws on any error or timeout.
function sessionConfig(cwd) {
  const login = lookup(['api', 'user', '--jq', '.login'], cwd);
  const repo = JSON.parse(lookup(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], cwd));
  const content = lookup(
    ['api', `repos/${repo.nameWithOwner}/contents/pipeline.config.json?ref=${repo.defaultBranchRef.name}`, '--jq', '.content'],
    cwd,
  );
  return { login, repo: repo.nameWithOwner, config: JSON.parse(Buffer.from(content, 'base64').toString('utf8')) };
}

// A delegate's own session may post the commands its grant covers. Any error or
// timeout denies. A repo with no delegates in its config is never looked up, so
// it denies at once, as it always has.
// The grant comes from the working directory's repo, so it only covers commands
// aimed at that repo: a command naming another repo is denied.
function defaultDelegateMayPost(words, cwd, target = null) {
  if (!defaultLocalDelegates(cwd)) return false;
  try {
    const { login, repo, config } = sessionConfig(cwd);
    if (target && !sameLogin(target, repo)) return false;
    return grantCovers(config, login, words);
  } catch {
    return false;
  }
}

// Whether this is a delegate's own session, for the rules only it gets. If the
// lookup fails, assume it is: those rules only take away.
function defaultIsDelegateSession(cwd) {
  if (!defaultLocalDelegates(cwd)) return false;
  try {
    const { login, config } = sessionConfig(cwd);
    return (Array.isArray(config.delegates) ? config.delegates : []).some((entry) => sameLogin(entry?.login, login));
  } catch {
    return true;
  }
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
