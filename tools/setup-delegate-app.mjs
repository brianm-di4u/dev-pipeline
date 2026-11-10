#!/usr/bin/env node
// Sets up a delegate clone to act as a GitHub App installation. The owner runs it,
// in their own terminal, through `tools/setup-delegate.ps1 -App`. Never run it from
// an agent session. It never prints the private key or a token.
//
// It asks for the App id, the downloaded private key and the clone. Then it reads
// the App and its installation, refuses a permission a delegate must not hold or a
// clone whose repo the App isn't installed on, and asks before writing anything.
// It moves the key out of Downloads to %USERPROFILE%\.pipeline-delegates\<slug>,
// readable by you only, writes the clone's .claude/settings.local.json, mints a
// first token, and prints the `delegates` entry to add to pipeline.config.json.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = await import(pathToFileURL(join(ROOT, 'template', '.claude', 'hooks', 'delegate-token.mjs')).href);
const API = 'https://api.github.com';

// Variables gh or git read a token, a host or a prompt from. A session inherits its
// parent's environment, and an inherited token beats gh's own login, so each is set
// empty, which gh and git treat as unset.
export const BLANKED = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GIT_ASKPASS', 'SSH_ASKPASS'];

// The App delegate's session environment. git's credential helpers are cleared
// first, both the general list and GitHub's own, so with no valid token a push
// fails rather than asking the owner's stored credentials.
export function delegateEnv({ dir, login, botId }) {
  const email = `${botId}+${login}@users.noreply.github.com`;
  return {
    ...Object.fromEntries(BLANKED.map((name) => [name, ''])),
    PIPELINE_DELEGATE_DIR: dir,
    GH_CONFIG_DIR: dir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_2: '!gh auth git-credential',
    GIT_AUTHOR_NAME: login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: login,
    GIT_COMMITTER_EMAIL: email,
  };
}

export const HOOK_ENTRY = {
  matcher: 'Bash|PowerShell',
  hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/delegate-token.mjs'], timeout: 30 }],
};

// Merges into what the clone's settings.local.json already holds. The token hook
// goes first among PreToolUse hooks, and any user-account token is dropped.
export function mergeSettings(existing, env, model) {
  const settings = { ...(existing ?? {}) };
  const kept = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([name]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)));
  settings.env = { ...kept, ...env };
  const pre = (settings.hooks?.PreToolUse ?? []).filter((entry) => !JSON.stringify(entry).includes('delegate-token.mjs'));
  settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: [HOOK_ENTRY, ...pre] };
  if (model) settings.model = model;
  return settings;
}

export function delegatesEntry(app) {
  return { app: { id: app.id, slug: app.slug }, approve: true, decide: ['design'], rearm: true, direct: false, since: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
}

// With no token, a public read, such as the bot's user id.
async function api(path, token = null) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dev-pipeline-setup' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
  return response.json();
}

function repoOf(clone) {
  const url = execFileSync('git', ['-C', clone, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`${clone}'s origin isn't a GitHub repo: ${url}`);
  return match[1];
}

// Readable by the current user only.
function protect(path) {
  if (process.platform === 'win32') {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)F`], { stdio: 'ignore' });
  } else {
    chmodSync(path, 0o700);
  }
}

function moveKey(from, to) {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from);
  }
  if (process.platform !== 'win32') chmodSync(to, 0o600);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const appId = Number(flag('--app-id') ?? (await prompt.question('App id: ')));
    const keyFile = resolve((flag('--key') ?? (await prompt.question('Path of the downloaded private key (.pem): '))).replace(/^"|"$/g, ''));
    const clone = resolve(flag('--clone') ?? (await prompt.question('Delegate clone: ')));
    const repo = repoOf(clone);

    const jwt = hook.appJwt(appId, readFileSync(keyFile, 'utf8'));
    const app = await api('/app', jwt);
    const installations = await api('/app/installations', jwt);
    const installation = installations.find((one) => one.account?.login?.toLowerCase() === repo.split('/')[0].toLowerCase());
    if (!installation) throw new Error(`${app.slug} isn't installed on ${repo.split('/')[0]}.`);
    hook.requestedPermissions(installation.permissions);
    const login = `${app.slug}[bot]`;
    const bot = await api(`/users/${encodeURIComponent(login)}`).catch(() => null);
    if (!bot?.id) throw new Error(`Could not read ${login}'s user id.`);

    console.log(`\nApp: ${app.slug} (id ${app.id}), owned by ${app.owner?.login}`);
    console.log(`Installation ${installation.id} on ${installation.account.login}, ${installation.repository_selection} repositories`);
    console.log(`Permissions: ${Object.entries(installation.permissions).map(([n, l]) => `${n}: ${l}`).join(', ')}`);
    console.log(`Bot: ${login}, user id ${bot.id}`);
    console.log(`Clone: ${clone} (${repo})`);
    const base = join(homedir(), '.pipeline-delegates', app.slug);
    const dir = join(base, repo.replace('/', '-'));
    console.log(`\nThis moves the key to ${join(base, 'app.pem')}, readable by you only, and writes ${join(clone, '.claude', 'settings.local.json')}.`);
    if (!/^y(es)?$/i.test(await prompt.question('Go ahead? (y/N) '))) {
      console.log('Nothing written.');
      return 1;
    }

    mkdirSync(dir, { recursive: true });
    protect(base);
    const pem = join(base, 'app.pem');
    if (resolve(keyFile) !== resolve(pem)) moveKey(keyFile, pem);
    writeFileSync(join(dir, 'delegate.json'), `${JSON.stringify({ appId: app.id, slug: app.slug, installationId: installation.id, repo }, null, 2)}\n`);
    // Before the session's settings point gh here: a hosts.yml without a token would
    // let gh fall back to your own keyring login.
    hook.clearToken(dir, login);

    const settingsPath = join(clone, '.claude', 'settings.local.json');
    const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(mergeSettings(existing, delegateEnv({ dir, login, botId: bot.id }), flag('--model')), null, 2)}\n`);
    const exclude = join(clone, execFileSync('git', ['-C', clone, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
    const lines = existsSync(exclude) ? readFileSync(exclude, 'utf8').split(/\r?\n/) : [];
    if (!lines.includes('.claude/settings.local.json')) writeFileSync(exclude, `${lines.join('\n').replace(/\n*$/, '\n')}.claude/settings.local.json\n`);

    const identity = await hook.refresh(dir);
    const probe = execFileSync('gh', ['api', 'installation/repositories', '--jq', '.repositories[].full_name'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, ...delegateEnv({ dir, login, botId: bot.id }) },
    }).trim();
    if (!probe.split('\n').some((name) => name.toLowerCase() === repo.toLowerCase())) throw new Error(`the first token doesn't reach ${repo}`);

    console.log(`\nDone. The token reaches ${repo}, and expires ${identity.expiresAt}; the hook renews it.`);
    console.log(`App id ${app.id}, slug ${app.slug}, bot user id ${bot.id}.`);
    console.log('\nAdd this to "delegates" in pipeline.config.json, through a PR you approve, and adjust the grant:\n');
    console.log(JSON.stringify(delegatesEntry(app), null, 2));
    console.log('\nThen open the clone in Claude Code once, and accept the trust prompt.');
    return 0;
  } catch (error) {
    console.error(`Setup stopped: ${error.message}`);
    return 1;
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
