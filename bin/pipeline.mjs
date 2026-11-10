#!/usr/bin/env node
// The owner's tool for setting up and maintaining projects. It runs with the
// owner's own credentials, which is why agents aren't allowed to run it.
//
//   pipeline init <dir> --pack <name> [--repo owner/name] [--private] [--no-github]
//   pipeline adopt <dir> --pack <name> --admin <login> [--project <name>]
//   pipeline protect [--repo owner/name] [--off]
//   pipeline doctor [--repo owner/name]
//   pipeline update [--check]
//   pipeline metrics [--repo owner/name] [--since YYYY-MM-DD] [--extended]
//   pipeline packs
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanFreshness } from '../template/.pipeline/lib/freshness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'template');
const PACKS = join(ROOT, 'packs');
const GITHUB_ACTIONS_APP_ID = 15368;
const MIN_CLAUDE_CODE = [2, 1, 295];

// Files a project owns from day one. `update` never touches these.
export const PROJECT_OWNED = [
  'CLAUDE.md',
  'REVIEW.md',
  'README.md',
  'pipeline.config.json',
  'pipeline.lock.json',
  'package.json',
  '.gitignore',
  '.gitattributes',
  'THIRD_PARTY.md',
  /^docs\//,
  /^evals\/review\/(cases|clean)\/(?!_starter)/,
];

const isProjectOwned = (path) =>
  PROJECT_OWNED.some((rule) => (typeof rule === 'string' ? rule === path : rule.test(path)));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function tryRun(command, args, options) {
  try {
    return run(command, args, options);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = argv[(i += 1)];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path).split(sep).join('/')];
  });
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function listPacks() {
  return readdirSync(PACKS).filter((name) => existsSync(join(PACKS, name, 'pack.json')));
}

// A pack can extend another, which is how the WASM pack reuses the browser harness.
export function loadPack(name) {
  const path = join(PACKS, name, 'pack.json');
  if (!existsSync(path)) throw new Error(`Unknown pack "${name}". Available: ${listPacks().join(', ')}`);
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  const own = { ...pack, chain: [name] };
  if (!pack.extends) return own;
  const parent = loadPack(pack.extends);
  return {
    ...parent,
    ...own,
    chain: [...parent.chain, name],
    verify: { ...parent.verify, ...pack.verify },
    t2Paths: [...(parent.t2Paths ?? []), ...(pack.t2Paths ?? [])],
    gitignore: [...(parent.gitignore ?? []), ...(pack.gitignore ?? [])],
    formatters: { ...parent.formatters, ...pack.formatters },
    ci: { setup: [...(parent.ci?.setup ?? []), ...(pack.ci?.setup ?? [])] },
  };
}

const packDirs = (pack, kind) =>
  pack.chain.map((name) => join(PACKS, name, kind)).filter((dir) => existsSync(dir));

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

const replaceTokens = (text, { admin, project, pack }) =>
  text
    .replaceAll('{{ADMIN}}', admin)
    .replaceAll('{{PROJECT}}', project)
    .replaceAll('{{SLUG}}', slugify(project))
    .replaceAll('{{PACK}}', pack);

const CI_SETUP_WORKFLOWS = ['ci.yml', 'post-merge.yml', 'release.yml'];

const applyCiSetup = (text, pack) => {
  const setup = renderCiSetup(pack);
  return text.replace(/^[ \t]*# PIPELINE:CI-SETUP\r?\n/m, setup ? `${setup}\n` : '');
};

export function renderCiSetup(pack, indent = '      ') {
  const steps = pack.ci?.setup ?? [];
  return steps
    .map((step) => {
      const lines = [`${indent}- name: ${step.name}`];
      if (step.uses) {
        lines.push(`${indent}  uses: ${step.uses}`);
        if (step.with) {
          lines.push(`${indent}  with:`);
          for (const [key, value] of Object.entries(step.with)) lines.push(`${indent}    ${key}: ${value}`);
        }
      }
      if (step.run) lines.push(`${indent}  run: ${step.run}`);
      return lines.join('\n');
    })
    .join('\n');
}

export function mergeConfig(config, pack) {
  return {
    ...config,
    verify: { ...config.verify, ...pack.verify },
    tiers: {
      ...config.tiers,
      t2Paths: [...config.tiers.t2Paths, ...(pack.t2Paths ?? [])],
    },
    formatters: { ...config.formatters, ...pack.formatters },
    ...(pack.licenseExceptions ? { licenseExceptions: pack.licenseExceptions } : {}),
    ...(pack.council ? { council: { ...config.council, ...pack.council } } : {}),
  };
}

// A managed file as this project should have it, with its tokens filled in.
function renderManaged(file, source, tokens, pack) {
  const content = readFileSync(source);
  if (content.includes(0)) return content;
  let text = replaceTokens(content.toString('utf8'), tokens);
  if (CI_SETUP_WORKFLOWS.some((name) => file === `.github/workflows/${name}`)) text = applyCiSetup(text, pack);
  return Buffer.from(text);
}

// Writes the template and pack into a directory, without touching git or GitHub.
export function scaffold(target, { pack: packName, admin, project }) {
  const pack = loadPack(packName);
  if (existsSync(target) && readdirSync(target).filter((name) => name !== '.git').length > 0) {
    throw new Error(`${target} isn't empty. The template is for new projects.`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE, target, { recursive: true });
  // `overlay` is managed by `pipeline update`. `starter` is a one-time starting
  // point, which belongs to the project as soon as it's copied.
  for (const kind of ['overlay', 'starter']) {
    for (const dir of packDirs(pack, kind)) cpSync(dir, target, { recursive: true, force: true });
  }

  for (const file of walk(target)) {
    if (file.startsWith('.git/')) continue;
    const path = join(target, file);
    const text = readFileSync(path);
    if (text.includes(0)) continue;
    const before = text.toString('utf8');
    const content = replaceTokens(before, { admin, project, pack: packName });
    if (content !== before) writeFileSync(path, content);
  }

  const configPath = join(target, 'pipeline.config.json');
  const config = mergeConfig(JSON.parse(readFileSync(configPath, 'utf8')), pack);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  for (const workflow of CI_SETUP_WORKFLOWS) {
    const path = join(target, '.github', 'workflows', workflow);
    if (existsSync(path)) writeFileSync(path, applyCiSetup(readFileSync(path, 'utf8'), pack));
  }

  if (pack.gitignore?.length) {
    const ignore = join(target, '.gitignore');
    writeFileSync(ignore, `${readFileSync(ignore, 'utf8')}${pack.gitignore.join('\n')}\n`);
  }

  writeLock(target, packName);
  return { pack, config };
}

// Brings the pipeline into an existing repository. Unlike `scaffold`, it never
// replaces a file that's already there, and it doesn't commit or touch GitHub. Only
// the files it wrote go in the lock, so a project's own version of a managed file
// shows up as a conflict in `update` rather than being silently overwritten.
export function adopt(target, { pack: packName, admin, project }) {
  const pack = loadPack(packName);
  if (!statSync(join(target, '.git'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${target} isn't the main checkout of a git repository.`);
  }
  if (existsSync(join(target, 'pipeline.lock.json'))) {
    throw new Error(`${target} already uses the pipeline. Run pipeline update instead.`);
  }

  const tokens = { admin, project, pack: packName };
  const sources = new Map();
  for (const base of [TEMPLATE, ...packDirs(pack, 'overlay')]) {
    for (const file of walk(base)) sources.set(file, join(base, file));
  }

  const written = [];
  const kept = [];
  for (const [file, source] of sources) {
    if (file === '.gitignore') continue;
    const destination = join(target, file);
    if (existsSync(destination)) {
      kept.push(file);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, renderManaged(file, source, tokens, pack));
    written.push(file);
  }

  if (written.includes('pipeline.config.json')) {
    const configPath = join(target, 'pipeline.config.json');
    const config = mergeConfig(JSON.parse(readFileSync(configPath, 'utf8')), pack);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const ignorePath = join(target, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const present = new Set(ignore.split(/\r?\n/));
  const missing = [...readFileSync(join(TEMPLATE, '.gitignore'), 'utf8').split(/\r?\n/), ...(pack.gitignore ?? [])]
    .filter((line, index, lines) => line && !present.has(line) && lines.indexOf(line) === index);
  if (missing.length > 0) {
    const gap = ignore && !ignore.endsWith('\n') ? '\n' : '';
    writeFileSync(ignorePath, `${ignore}${gap}${missing.join('\n')}\n`);
  }

  if (existsSync(join(target, '.git', 'hooks', 'pre-push'))) kept.push('.git/hooks/pre-push');
  else installGitHooks(target);

  writeLock(target, packName, new Set(written));
  return { pack, written, kept };
}

function managedSources(pack) {
  const sources = new Map();
  for (const base of [TEMPLATE, ...packDirs(pack, 'overlay')]) {
    for (const file of walk(base)) {
      if (!isProjectOwned(file)) sources.set(file, join(base, file));
    }
  }
  return sources;
}

export function writeLock(target, packName, only = null) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const files = {};
  for (const file of managedSources(loadPack(packName)).keys()) {
    const path = join(target, file);
    if (existsSync(path) && (!only || only.has(file))) files[file] = sha256(readFileSync(path));
  }
  writeFileSync(
    join(target, 'pipeline.lock.json'),
    `${JSON.stringify({ template: 'dev-pipeline', version, pack: packName, files }, null, 2)}\n`,
  );
}

function installGitHooks(target) {
  const source = join(target, '.pipeline', 'githooks', 'pre-push');
  const hooks = join(target, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  copyFileSync(source, join(hooks, 'pre-push'));
  try {
    chmodSync(join(hooks, 'pre-push'), 0o755);
  } catch {
    // Windows has no execute bit, and Git for Windows doesn't need one.
  }
}

async function init({ positional, flags }) {
  const dir = positional[0];
  if (!dir || !flags.pack || flags.pack === true) {
    throw new Error(`Usage: pipeline init <dir> --pack <${listPacks().join('|')}> [--repo owner/name] [--private] [--no-github]`);
  }
  const target = resolve(dir);
  const project = basename(target);
  const github = !flags['no-github'];
  const admin =
    flags.admin ?? (github ? run('gh', ['api', 'user', '--jq', '.login']) : 'ADMIN_LOGIN');
  const repo = flags.repo ?? `${admin}/${project}`;

  scaffold(target, { pack: flags.pack, admin, project });
  console.log(`Scaffolded ${project} with the ${flags.pack} pack.`);

  run('git', ['init', '-q', '-b', 'main'], { cwd: target });
  installGitHooks(target);
  run('git', ['add', '-A'], { cwd: target });
  run('git', ['commit', '-q', '-m', 'Start from dev-pipeline template'], { cwd: target });

  if (!github) {
    console.log('Skipped GitHub. Run this later: pipeline protect --repo owner/name');
    return 0;
  }
  const visibility = flags.private ? '--private' : '--public';
  run('gh', ['repo', 'create', repo, visibility, '--source', target, '--remote', 'origin'], { cwd: target });
  run('git', ['push', '-q', '-u', 'origin', 'main'], {
    cwd: target,
    env: { ...process.env, PIPELINE_ADMIN_PUSH: '1' },
  });
  console.log(`Created ${repo} (${flags.private ? 'private' : 'public'}).`);
  await protect({ flags: { repo } });
  return doctor({ flags: { repo, dir: target } });
}

async function adoptProject({ positional, flags }) {
  const dir = positional[0];
  const named = (value) => (typeof value === 'string' ? value : null);
  if (!dir || !named(flags.pack) || !named(flags.admin)) {
    throw new Error(`Usage: pipeline adopt <dir> --pack <${listPacks().join('|')}> --admin <login> [--project <name>]`);
  }
  const target = resolve(dir);
  const project = named(flags.project) ?? basename(target);
  const { written, kept } = adopt(target, { pack: flags.pack, admin: flags.admin, project });
  console.log(`Adopted ${project} with the ${flags.pack} pack: ${written.length} files written, ${kept.length} kept.`);
  for (const file of kept) console.log(`  KEPT ${file}`);
  console.log('Nothing was committed or pushed. Review this on a branch, fill in the docs, and open a PR.');
  return 0;
}

const AGENT_LABELS = { 'decision-needed': 'fbca04', 'blocked:decision': 'fbca04', triage: 'd93f0b' };
// Only a project with a delegate in its config gets these.
export const DELEGATE_LABELS = {
  'admin-needed': 'b60205',
  garden: '0e8a16',
  'complexity:high': '5319e7',
  'complexity:low': 'c5def5',
  'pipeline:delegate-suspended': 'b60205',
  'pipeline:delegate-touched': 'd93f0b',
  'pipeline:delegate-approved': 'c5def5',
  'pipeline:delegate-rearmed': 'c5def5',
};

export function labelsFor(config) {
  const delegated = Array.isArray(config?.delegates) && config.delegates.length > 0;
  return delegated ? { ...AGENT_LABELS, ...DELEGATE_LABELS } : AGENT_LABELS;
}

function localConfig(dir) {
  try {
    return JSON.parse(readFileSync(join(resolve(dir ?? '.'), 'pipeline.config.json'), 'utf8'));
  } catch {
    return null;
  }
}

function ghApi(args, input) {
  const result = spawnSync('gh', ['api', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

function currentRepo(cwd) {
  return run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
}

export const protectionBody = {
  required_status_checks: {
    strict: true,
    checks: [{ context: 'pipeline/gate', app_id: GITHUB_ACTIONS_APP_ID }],
  },
  enforce_admins: true,
  // Zero approvals: one account can't approve its own PR, so the gate does this.
  required_pull_request_reviews: { required_approving_review_count: 0 },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
};

async function protect({ flags }) {
  const repo = flags.repo ?? currentRepo();
  const info = JSON.parse(run('gh', ['api', `repos/${repo}`]));

  // Break glass, for when a broken gate can't approve its own fix. Owner only.
  if (flags.off) {
    const off = ghApi(['-X', 'DELETE', `repos/${repo}/branches/${info.default_branch}/protection`]);
    console.log(off.ok ? 'Protection is OFF. Push the fix, then run: pipeline protect' : off.stderr.trim());
    return off.ok ? 0 : 1;
  }

  const steps = [
    [
      'Merge settings',
      () =>
        ghApi(
          ['-X', 'PATCH', `repos/${repo}`, '--input', '-'],
          JSON.stringify({
            allow_auto_merge: true,
            allow_squash_merge: true,
            allow_merge_commit: false,
            allow_rebase_merge: false,
            delete_branch_on_merge: true,
            squash_merge_commit_title: 'PR_TITLE',
            squash_merge_commit_message: 'PR_BODY',
          }),
        ),
    ],
    [
      'Workflow token defaults to read-only',
      () =>
        ghApi(
          ['-X', 'PUT', `repos/${repo}/actions/permissions/workflow`, '--input', '-'],
          JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }),
        ),
    ],
    ['Dependabot alerts', () => ghApi(['-X', 'PUT', `repos/${repo}/vulnerability-alerts`])],
    [
      // The skills file issues under these. GitHub refuses an issue whose label doesn't exist,
      // and the bot only makes the labels it applies itself.
      'Labels agents file under',
      () => {
        for (const [name, color] of Object.entries(labelsFor(localConfig(flags.dir)))) {
          const made = ghApi(['-X', 'POST', `repos/${repo}/labels`, '-f', `name=${name}`, '-f', `color=${color}`]);
          if (!made.ok && !/already_exists/.test(made.stdout + made.stderr)) return made;
        }
        return { ok: true, stdout: '', stderr: '' };
      },
    ],
  ];

  if (!info.private) {
    steps.push(
      [
        'Branch protection',
        () =>
          ghApi(
            ['-X', 'PUT', `repos/${repo}/branches/${info.default_branch}/protection`, '--input', '-'],
            JSON.stringify(protectionBody),
          ),
      ],
      [
        'Secret scanning and push protection',
        () =>
          ghApi(
            ['-X', 'PATCH', `repos/${repo}`, '--input', '-'],
            JSON.stringify({
              security_and_analysis: {
                secret_scanning: { status: 'enabled' },
                secret_scanning_push_protection: { status: 'enabled' },
              },
            }),
          ),
      ],
      [
        'Approval required for outside contributors',
        () =>
          ghApi(
            ['-X', 'PUT', `repos/${repo}/actions/permissions/fork-pr-contributor-approval`, '--input', '-'],
            JSON.stringify({ approval_policy: 'all_external_contributors' }),
          ),
      ],
      [
        'CodeQL default setup',
        () =>
          ghApi(
            ['-X', 'PATCH', `repos/${repo}/code-scanning/default-setup`, '--input', '-'],
            JSON.stringify({ state: 'configured' }),
          ),
      ],
    );
  }

  let failed = 0;
  for (const [name, step] of steps) {
    // GitHub briefly refuses settings changes after a repo changes visibility.
    let result = step();
    for (let attempt = 0; !result.ok && attempt < 6 && name !== 'CodeQL default setup'; attempt += 1) {
      await new Promise((done) => setTimeout(done, 15000));
      result = step();
    }
    console.log(`${result.ok ? 'ok    ' : 'FAILED'} ${name}`);
    if (!result.ok) {
      // CodeQL can't be set up until the repo has a language it supports.
      if (name !== 'CodeQL default setup') failed += 1;
      console.log(`       ${result.stderr.trim().split('\n')[0]}`);
    }
  }
  if (info.private) {
    console.log('Private repo on the Free plan: no branch protection is available, so enforcement is advisory.');
    console.log('Agents stop at ready here, and you merge.');
  } else if (localConfig(flags.dir)?.freshness !== undefined) {
    console.log('This requires branches to be up to date. With "freshness" set, turn that off by hand in the branch rule if you want PRs to merge in parallel.');
  }
  return failed === 0 ? 0 : 1;
}

export function compareVersions(version, minimum) {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    if ((parts[i] ?? 0) !== minimum[i]) return (parts[i] ?? 0) > minimum[i];
  }
  return true;
}

function claudeVersion() {
  const fromPath = process.env.CLAUDE_CODE_EXECPATH ?? 'claude';
  return /(\d+\.\d+\.\d+)/.exec(tryRun(fromPath, ['--version']) ?? '')?.[1] ?? null;
}

async function doctor({ flags }) {
  const cwd = resolve(flags.dir ?? '.');
  const results = [];
  const add = (level, name, detail = '') => results.push({ level, name, detail });

  for (const [tool, args] of [['node', ['--version']], ['git', ['--version']], ['gh', ['--version']]]) {
    const version = tryRun(tool, args);
    add(version ? 'ok' : 'fail', tool, version?.split('\n')[0] ?? 'not found');
  }
  const python = tryRun('python', ['--version']);
  add(python ? 'ok' : 'warn', 'python', python ?? 'not found. babysit-pr needs it for pr-wait.');

  const claude = claudeVersion();
  if (!claude) add('warn', 'Claude Code', 'version unknown. The guard hook needs v2.1.295 or later.');
  else if (compareVersions(claude, MIN_CLAUDE_CODE)) add('ok', 'Claude Code', claude);
  else add('fail', 'Claude Code', `${claude} is too old: the guard hook would fail open. Need v2.1.295+.`);

  const configPath = join(cwd, 'pipeline.config.json');
  let config = null;
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
    add('ok', 'pipeline.config.json', `pack: ${config.pack}`);
    for (const level of ['fast', 'full', 'e2e']) {
      const value = [config.verify?.[level] ?? []].flat();
      if (value.length === 0 || value.some((c) => /^TODO\b/.test(c))) {
        add('warn', `verify.${level}`, 'not set yet');
      }
    }
    if (config.council?.externalSeats?.includes('codex') && cwd.toLowerCase().startsWith(process.env.USERPROFILE?.toLowerCase() ?? '\0')) {
      add('fail', 'Codex seat', "Codex's Windows sandbox can't read under your user profile. Move the project.");
    }
  } else {
    add('fail', 'pipeline.config.json', `not found in ${cwd}`);
  }
  add(existsSync(join(cwd, '.git', 'hooks', 'pre-push')) ? 'ok' : 'warn', 'pre-push hook', '');

  // Until a folder is trusted, Claude Code ignores its permission rules, so unattended runs would stall on prompts.
  try {
    const state = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    const trusted = state.projects?.[cwd.replaceAll('\\', '/')]?.hasTrustDialogAccepted === true;
    add(trusted ? 'ok' : 'warn', 'Workspace trust', trusted ? '' : 'open this folder in Claude Code once and accept the trust prompt.');
  } catch {
    add('warn', 'Workspace trust', 'unknown. Open this folder in Claude Code once and accept the trust prompt.');
  }

  let enforcement = 'unknown';
  const repo = flags.repo ?? tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
  if (repo) {
    const info = JSON.parse(run('gh', ['api', `repos/${repo}`]));
    const branch = JSON.parse(run('gh', ['api', `repos/${repo}/branches/${info.default_branch}`]));
    const checks = branch.protection?.required_status_checks?.checks ?? [];
    const pinned = checks.some((c) => c.context === 'pipeline/gate' && c.app_id === GITHUB_ACTIONS_APP_ID);
    const everyone = branch.protection?.required_status_checks?.enforcement_level === 'everyone';
    if (info.private) {
      enforcement = 'advisory';
      add('warn', 'Enforcement', 'ADVISORY: a private repo on Free has no protection. Agents stop at ready.');
    } else if (branch.protected && pinned && everyone) {
      enforcement = 'enforced';
      add('ok', 'Enforcement', 'ENFORCED: pipeline/gate is required, pinned to GitHub Actions, admins included.');
    } else {
      enforcement = 'unprotected';
      add('fail', 'Enforcement', 'UNPROTECTED: run pipeline protect.');
    }
    if (!info.private) add(info.allow_auto_merge ? 'ok' : 'fail', 'Auto-merge', info.allow_auto_merge ? 'enabled' : 'run pipeline protect');
    const gateYml = join(cwd, '.github', 'workflows', 'gate.yml');
    const runsOnPush = existsSync(gateYml) ? /^\s+push:/m.test(readFileSync(gateYml, 'utf8')) : null;
    const fresh = freshnessCheck(config, readStrict(repo, info.default_branch), runsOnPush);
    if (fresh) add(fresh.level, fresh.name, fresh.detail);
  } else {
    add('warn', 'GitHub', 'no remote repo found');
  }

  const token = tokenCheck(spawnSync('gh', ['api', '-i', 'user'], { encoding: 'utf8' }).stdout ?? '', config);
  add(token.level, token.name, token.detail);

  const mark = { ok: 'ok   ', warn: 'warn ', fail: 'FAIL ' };
  for (const { level, name, detail } of results) console.log(`${mark[level]} ${name}${detail ? `: ${detail}` : ''}`);
  console.log(`\nEnforcement level: ${enforcement}`);
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

// Whether GitHub requires branches to be up to date before merging, from branch
// protection or a ruleset: true, false, or null when it can't be read.
function readStrict(repo, branch) {
  const classic = tryRun('gh', ['api', `repos/${repo}/branches/${branch}/protection/required_status_checks`, '--jq', '.strict']);
  const rules = tryRun('gh', [
    'api',
    `repos/${repo}/rules/branches/${branch}`,
    '--jq',
    '[.[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy] | any',
  ]);
  if (classic === 'true' || rules === 'true') return true;
  if (classic === 'false' && rules === 'false') return false;
  return null;
}

// Branch freshness and GitHub's "require branches to be up to date" rule work as a
// pair. With freshness on, the rule makes it moot until the admin turns the rule
// off. With the rule off and no freshness, nothing stops a merge on a stale base.
// Null when there's nothing to say, which is the case without freshness and with
// the rule on, as before.
export function freshnessCheck(config, strict, runsOnPush = null) {
  const name = 'Branch freshness';
  if (config?.freshness === undefined) {
    if (strict === false) {
      return { level: 'warn', name, detail: 'UNGUARDED: GitHub does not require branches to be up to date, and pipeline.config.json has no "freshness". Turn the rule back on, or add freshness.' };
    }
    return null;
  }
  let problem = null;
  const setting = cleanFreshness(config.freshness, (message) => {
    problem = message;
  });
  if (setting.mode !== 'overlap') return { level: 'warn', name, detail: `${problem} Fix it, or remove it.` };
  if (runsOnPush === false) {
    return { level: 'warn', name, detail: 'gate.yml does not run on a push to main, so a merge that stales an open PR leaves its gate green until its next event. Update gate.yml.' };
  }
  if (strict === true) {
    return { level: 'warn', name, detail: 'no effect yet: GitHub still requires branches to be up to date. The admin turns that rule off by hand, never an agent.' };
  }
  if (strict === false) return { level: 'ok', name, detail: 'overlap: a PR behind main merges unless main changed something it depends on' };
  return { level: 'warn', name, detail: 'overlap is set, but whether GitHub requires branches to be up to date could not be read' };
}

// What `gh api -i user` says about the token this session holds. A delegate is its
// own account on a repo it's a collaborator on, where fine-grained tokens don't
// work, so a classic token is expected there.
export function tokenCheck(response, config) {
  const classic = /^x-oauth-scopes:\s*(.*)$/im.exec(response)?.[1]?.trim();
  const login = /"login"\s*:\s*"([^"]+)"/.exec(response)?.[1] ?? null;
  const delegates = Array.isArray(config?.delegates) ? config.delegates : [];
  const delegate = login && delegates.find((entry) => typeof entry?.login === 'string' && entry.login.toLowerCase() === login.toLowerCase());
  if (delegate && !(config.admins ?? []).some((admin) => admin.toLowerCase() === login.toLowerCase())) {
    return {
      level: 'ok',
      name: 'Delegate token',
      detail: `${login} is a delegate in pipeline.config.json, so a classic token is expected (scopes: ${classic || 'none reported'}). It should have only public_repo, workflow and read:org.`,
    };
  }
  if (classic && /\brepo\b/.test(classic)) {
    return {
      level: 'warn',
      name: 'Agent token',
      detail: `gh holds a broad token (${classic}). Give agents the restricted token: see docs/AGENT-TOKEN.md in dev-pipeline.`,
    };
  }
  return { level: 'ok', name: 'Agent token', detail: 'gh is not using a broad classic or OAuth token' };
}

// Updates managed files in the current project. A file changed since the last
// update is left alone and reported, so local fixes are never overwritten.
export function planUpdate(target) {
  const lock = JSON.parse(readFileSync(join(target, 'pipeline.lock.json'), 'utf8'));
  const pack = loadPack(lock.pack);
  const config = JSON.parse(readFileSync(join(target, 'pipeline.config.json'), 'utf8'));
  const tokens = { admin: config.admins[0], project: config.project, pack: lock.pack };

  const plan = { add: [], update: [], conflict: [], same: [] };
  for (const [file, source] of managedSources(pack)) {
    const content = renderManaged(file, source, tokens, pack);
    const destination = join(target, file);
    const incomingHash = sha256(content);
    if (!existsSync(destination)) {
      plan.add.push({ file, content, incomingHash });
      continue;
    }
    const currentHash = sha256(readFileSync(destination));
    if (currentHash === incomingHash) plan.same.push(file);
    else if (lock.files[file] && lock.files[file] === currentHash) plan.update.push({ file, content, incomingHash });
    else plan.conflict.push(file);
  }
  return { plan, lock };
}

async function update({ flags }) {
  const target = resolve(flags.dir ?? '.');
  const { plan, lock } = planUpdate(target);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  console.log(`From template ${lock.version} to ${version}:`);
  console.log(`  ${plan.add.length} new, ${plan.update.length} updated, ${plan.same.length} unchanged, ${plan.conflict.length} locally modified`);
  for (const { file } of plan.add) console.log(`  new      ${file}`);
  for (const { file } of plan.update) console.log(`  update   ${file}`);
  for (const file of plan.conflict) console.log(`  KEPT     ${file} (changed locally; merge by hand)`);
  if (flags.check) return plan.add.length + plan.update.length > 0 ? 1 : 0;

  for (const { file, content, incomingHash } of [...plan.add, ...plan.update]) {
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    lock.files[file] = incomingHash;
  }
  lock.version = version;
  writeFileSync(join(target, 'pipeline.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  installGitHooks(target);
  console.log('Commit this on a branch and open a PR. It touches protected paths, so it needs your approval.');
  return 0;
}

// The weekly digest, on demand. It's the only digest a private repo gets, since CI
// doesn't run there.
async function metrics({ flags }) {
  const repo = flags.repo ?? currentRepo();
  const config = JSON.parse(readFileSync(join(resolve(flags.dir ?? '.'), 'pipeline.config.json'), 'utf8'));
  const lib = (name) => pathToFileURL(join(TEMPLATE, '.pipeline', 'lib', name)).href;
  const { buildDigest, renderDigest } = await import(lib('digest.mjs'));
  const { cliClient } = await import(lib('github.mjs'));
  const bot = encodeURIComponent('github-actions[bot]');
  const botIssues = (client, name, label, state = 'open') =>
    client.list(`/repos/${name}/issues?state=${state}&labels=${encodeURIComponent(label)}&creator=${bot}&per_page=100`);
  // --since sets the start, for a baseline. --extended adds the delegate measures,
  // such as approval wait, even before a delegate is configured.
  let since = null;
  if (typeof flags.since === 'string') {
    if (Number.isNaN(Date.parse(flags.since))) throw new Error(`--since takes a date, such as 2026-11-07, not ${flags.since}`);
    since = new Date(flags.since).toISOString();
  }
  const data = await buildDigest({ client: cliClient(), repo, config, now: new Date(), botIssues, since, extended: flags.extended === true });
  console.log(renderDigest(data, config));
  return 0;
}

const COMMANDS = { init, adopt: adoptProject, protect, doctor, update, metrics, packs: async () => (console.log(listPacks().join('\n')), 0) };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(`Usage: pipeline <${Object.keys(COMMANDS).join('|')}>`);
    return 2;
  }
  return COMMANDS[command](parseArgs(rest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
