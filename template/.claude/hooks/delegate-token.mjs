#!/usr/bin/env node
// PreToolUse hook for an App delegate's own clone: keep a fresh installation token
// where gh reads it. Wired in that clone's .claude/settings.local.json only, for
// the Bash and PowerShell tools. See docs/AGENT-TOKEN.md in dev-pipeline.
//
// The delegate's state lives outside the clone, in PIPELINE_DELEGATE_DIR, which is
// also the session's GH_CONFIG_DIR:
//
//   <dir>/../app.pem        the App's private key, readable by the owner's user only
//   <dir>/delegate.json     the App id, slug, installation id and repo; no secret
//   <dir>/hosts.yml         gh's login, holding the installation token
//   <dir>/identity.json     who the token is, its expiry and permissions; no secret
//
// It never prints a token or the key. gh falls back to the owner's keyring login
// whenever hosts.yml holds no token, so hosts.yml always holds one: if the hook
// can't mint, it writes a token GitHub refuses, and gh and git fail as nobody.
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const REFRESH_MS = 20 * 60 * 1000;

// What a delegate's token may hold, and the most of each. Anything else on the
// installation, such as checks write or administration, refuses the mint.
export const ALLOWED = {
  contents: 'write',
  workflows: 'write',
  issues: 'write',
  pull_requests: 'write',
  actions: 'read',
  checks: 'read',
  metadata: 'read',
};
const RANK = { read: 1, write: 2, admin: 3 };

// The permissions to request: the installation's own, each within ALLOWED. Throws
// on any permission outside it, naming the permission and never a secret.
export function requestedPermissions(installed) {
  const extra = Object.entries(installed ?? {}).filter(([name, level]) => !(name in ALLOWED) || RANK[level] > RANK[ALLOWED[name]]);
  if (extra.length > 0) throw new Error(`the App has permissions a delegate must not hold: ${extra.map(([n, l]) => `${n}: ${l}`).join(', ')}`);
  return { ...installed };
}

const base64url = (value) => Buffer.from(value).toString('base64url');

// An RS256 JWT for the App: issued 60 seconds back for clock drift, valid 9 minutes.
export function appJwt(appId, pem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(pem)).toString('base64url');
  return `${head}.${body}.${signature}`;
}

export const needsToken = (identity, now = Date.now()) => !identity || !(Date.parse(identity.expiresAt) - now > REFRESH_MS);

// Write by rename, so a reader never sees half a file.
export function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

export function hostsYaml(login, token) {
  return [
    'github.com:',
    '    git_protocol: https',
    '    users:',
    `        ${login}:`,
    `            oauth_token: ${token}`,
    `    oauth_token: ${token}`,
    `    user: ${login}`,
    '',
  ].join('\n');
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

// gh falls back to the owner's keyring login when hosts.yml holds no token, so a
// token is never just removed: it is replaced by one GitHub refuses. Then gh and
// git fail with "Bad credentials", as nobody.
export const NO_TOKEN = 'pipeline-delegate-no-token';

export function clearToken(dir, login = 'pipeline-delegate[bot]') {
  writeAtomic(join(dir, 'config.yml'), 'version: "1"\n');
  writeAtomic(join(dir, 'hosts.yml'), hostsYaml(login, NO_TOKEN));
  rmSync(join(dir, 'identity.json'), { force: true });
}

function setupLogin(dir) {
  const setup = readJson(join(dir, 'delegate.json'));
  return typeof setup?.slug === 'string' ? `${setup.slug}[bot]` : undefined;
}

// Mint an installation token for the working repo, and write it where gh reads it.
export async function refresh(dir, { fetcher = fetch, now = Date.now() } = {}) {
  const setup = readJson(join(dir, 'delegate.json'));
  if (!setup?.appId || !setup?.installationId || !setup?.repo || !setup?.slug) throw new Error('delegate.json is missing or incomplete');
  const login = `${setup.slug}[bot]`;
  const jwt = appJwt(setup.appId, readFileSync(join(dirname(dir), 'app.pem'), 'utf8'), now);
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dev-pipeline-delegate' };
  const installation = await fetcher(`${API}/app/installations/${setup.installationId}`, { headers });
  if (!installation.ok) throw new Error(`reading the installation returned HTTP ${installation.status}`);
  const installed = await installation.json();
  if (installed.app_id !== setup.appId) throw new Error('the installation belongs to another App');
  const permissions = requestedPermissions(installed.permissions);
  const response = await fetcher(`${API}/app/installations/${setup.installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [setup.repo.split('/')[1]], permissions }),
  });
  if (!response.ok) throw new Error(`minting a token returned HTTP ${response.status}`);
  const minted = await response.json();
  requestedPermissions(minted.permissions);
  writeAtomic(join(dir, 'config.yml'), 'version: "1"\n');
  writeAtomic(join(dir, 'hosts.yml'), hostsYaml(login, minted.token));
  const identity = { appId: setup.appId, slug: setup.slug, login, repo: setup.repo, installationId: setup.installationId, expiresAt: minted.expires_at, permissions: minted.permissions };
  writeAtomic(join(dir, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export async function main(env = process.env, options = {}) {
  const dir = env.PIPELINE_DELEGATE_DIR;
  if (!dir) return 0;
  let login;
  try {
    login = setupLogin(dir);
    // Never a moment without a token in hosts.yml, or gh would use the owner's login.
    if (!existsSync(join(dir, 'hosts.yml'))) clearToken(dir, login);
    if (!needsToken(readJson(join(dir, 'identity.json')), options.now)) return 0;
    await refresh(dir, options);
  } catch (error) {
    // A token GitHub refuses, not anyone else's: gh then fails until a mint succeeds.
    try {
      clearToken(dir, login);
    } catch {
      // The folder itself is gone or unwritable; gh has nothing of the delegate's to use.
    }
    process.stderr.write(`delegate token: ${error.message}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A PreToolUse hook gets the tool call on stdin. It isn't needed here.
  process.stdin.resume();
  process.stdin.on('end', () => {
    main().then((code) => {
      process.exitCode = code;
    });
  });
}
