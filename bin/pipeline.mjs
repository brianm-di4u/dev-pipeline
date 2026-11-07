#!/usr/bin/env node
// The owner's tool for setting up and maintaining projects. It runs with the
// owner's own credentials, which is why agents aren't allowed to run it.
//
//   pipeline init <dir> --pack <name> [--repo owner/name] [--private] [--no-github]
//   pipeline protect [--repo owner/name]
//   pipeline doctor [--repo owner/name]
//   pipeline update [--check]
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function loadPack(name) {
  const path = join(PACKS, name, 'pack.json');
  if (!existsSync(path)) throw new Error(`Unknown pack "${name}". Available: ${listPacks().join(', ')}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

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
    ...(pack.council ? { council: { ...config.council, ...pack.council } } : {}),
  };
}

// Writes the template and pack into a directory, without touching git or GitHub.
export function scaffold(target, { pack: packName, admin, project }) {
  const pack = loadPack(packName);
  if (existsSync(target) && readdirSync(target).filter((name) => name !== '.git').length > 0) {
    throw new Error(`${target} isn't empty. The template is for new projects.`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE, target, { recursive: true });
  const overlay = join(PACKS, packName, 'overlay');
  if (existsSync(overlay)) cpSync(overlay, target, { recursive: true, force: true });

  const tokens = { '{{ADMIN}}': admin, '{{PROJECT}}': project, '{{PACK}}': packName };
  for (const file of walk(target)) {
    if (file.startsWith('.git/')) continue;
    const path = join(target, file);
    const text = readFileSync(path);
    if (text.includes(0)) continue;
    let content = text.toString('utf8');
    const before = content;
    for (const [token, value] of Object.entries(tokens)) content = content.replaceAll(token, value);
    if (content !== before) writeFileSync(path, content);
  }

  const configPath = join(target, 'pipeline.config.json');
  const config = mergeConfig(JSON.parse(readFileSync(configPath, 'utf8')), pack);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  for (const workflow of ['ci.yml', 'post-merge.yml']) {
    const path = join(target, '.github', 'workflows', workflow);
    if (existsSync(path)) {
      const setup = renderCiSetup(pack);
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(/^[ \t]*# PIPELINE:CI-SETUP\r?\n/m, setup ? `${setup}\n` : ''),
      );
    }
  }

  if (pack.gitignore?.length) {
    const ignore = join(target, '.gitignore');
    writeFileSync(ignore, `${readFileSync(ignore, 'utf8')}${pack.gitignore.join('
')}
`);
  }

  writeLock(target, packName);
  return { pack, config };
}

export function writeLock(target, packName) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const files = {};
  for (const file of walk(target)) {
    if (file.startsWith('.git/') || file === 'pipeline.lock.json') continue;
    if (!isProjectOwned(file)) files[file] = sha256(readFileSync(join(target, file)));
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
    const result = step();
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
  } else {
    add('warn', 'GitHub', 'no remote repo found');
  }

  const scopes = spawnSync('gh', ['api', '-i', 'user'], { encoding: 'utf8' }).stdout ?? '';
  const classic = /^x-oauth-scopes:\s*(.*)$/im.exec(scopes)?.[1]?.trim();
  if (classic && /\brepo\b/.test(classic)) {
    add('warn', 'Agent token', `gh holds a broad token (${classic}). Give agents the restricted token: see docs/AGENT-TOKEN.md in dev-pipeline.`);
  } else {
    add('ok', 'Agent token', 'gh is not using a broad classic or OAuth token');
  }

  const mark = { ok: 'ok   ', warn: 'warn ', fail: 'FAIL ' };
  for (const { level, name, detail } of results) console.log(`${mark[level]} ${name}${detail ? `: ${detail}` : ''}`);
  console.log(`\nEnforcement level: ${enforcement}`);
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

// Updates managed files in the current project. A file changed since the last
// update is left alone and reported, so local fixes are never overwritten.
export function planUpdate(target) {
  const lock = JSON.parse(readFileSync(join(target, 'pipeline.lock.json'), 'utf8'));
  const pack = loadPack(lock.pack);
  const incoming = new Map();
  const add = (base) => {
    if (!existsSync(base)) return;
    for (const file of walk(base)) incoming.set(file, join(base, file));
  };
  add(TEMPLATE);
  add(join(PACKS, lock.pack, 'overlay'));

  const plan = { add: [], update: [], conflict: [], same: [] };
  for (const [file, source] of incoming) {
    if (isProjectOwned(file)) continue;
    let content = readFileSync(source);
    if (!content.includes(0)) {
      const config = JSON.parse(readFileSync(join(target, 'pipeline.config.json'), 'utf8'));
      let text = content
        .toString('utf8')
        .replaceAll('{{ADMIN}}', config.admins[0])
        .replaceAll('{{PROJECT}}', config.project)
        .replaceAll('{{PACK}}', lock.pack);
      if (file === '.github/workflows/ci.yml' || file === '.github/workflows/post-merge.yml') {
        const setup = renderCiSetup(pack);
        text = text.replace(/^[ \t]*# PIPELINE:CI-SETUP\r?\n/m, setup ? `${setup}\n` : '');
      }
      content = Buffer.from(text);
    }
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

const COMMANDS = { init, protect, doctor, update, packs: async () => (console.log(listPacks().join('\n')), 0) };

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
