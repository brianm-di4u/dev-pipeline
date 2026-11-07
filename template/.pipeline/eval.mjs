#!/usr/bin/env node
// Scores the council against known bugs and known-clean changes.
//
//   eval.mjs prepare <dir> [--split train|test] [--cases a,b]   Build a repo per case, and a plan for each
//   eval.mjs grade <dir> <results.json>                         Score the results, and print a report
//
// Run a full cycle with the reviewer-eval skill. Rerun whenever seat prompts, tools,
// or models change, and compare against the last baseline.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { gradeCase, scoreCases } from './lib/evals.mjs';
import { selectSeats } from './lib/ledger.mjs';
import { loadPersonas } from './lib/personas.mjs';

async function loadCases() {
  const starter = pathToFileURL(resolve('evals/review/_starter/cases.mjs')).href;
  const { cases } = await import(starter);
  const dir = join('evals', 'review', 'cases');
  const incidents = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    : [];
  return [...cases, ...incidents];
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export function buildCaseRepo(root, kase, reviewRules) {
  // An opaque directory name, so the path doesn't hint at the answer.
  const index = root.nextIndex++;
  const dir = join(root.path, `case-${String(index).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Eval');
  git(dir, 'config', 'user.email', 'eval@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFiles(dir, { ...kase.base, 'REVIEW.md': reviewRules });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Base');
  const mergeBase = git(dir, 'rev-parse', 'HEAD');
  writeFiles(dir, kase.head);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Change');
  return { dir: dir.replaceAll('\\', '/'), mergeBase, head: git(dir, 'rev-parse', 'HEAD') };
}

// Real evidence, so the evidence seat judges what a real author would have shown it.
function runCaseTests(dir) {
  if (!existsSync(join(dir, 'tests'))) return 'This change has no tests, and no verification was run.\n';
  const run = spawnSync('node', ['--test', 'tests/*.test.js'], { cwd: dir, encoding: 'utf8' });
  return `$ node --test tests/*.test.js\n${run.stdout}${run.stderr}\nexit code: ${run.status}\n`;
}

async function prepare(args) {
  const out = resolve(args[0]);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const split = flag('--split');
  const only = flag('--cases')?.split(',');
  const config = loadConfig();
  const reviewRules = readFileSync('REVIEW.md', 'utf8');
  const selected = (await loadCases()).filter((kase) => (!split || kase.split === split) && (!only || only.includes(kase.id)));

  const root = { path: out, nextIndex: 1 };
  mkdirSync(out, { recursive: true });
  const plans = [];
  const index = {};
  for (const kase of selected) {
    const repo = buildCaseRepo(root, kase, reviewRules);
    const paths = Object.keys(kase.head);
    const evidenceDir = join(repo.dir, '.evidence').replaceAll('\\', '/');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'full.log'), runCaseTests(repo.dir));
    const key = repo.dir.split('/').pop();
    index[key] = kase.id;
    plans.push({
      key,
      cwd: repo.dir,
      mode: 'full',
      tier: 1,
      intent: kase.intent,
      outOfScope: null,
      mergeBase: repo.mergeBase,
      head: repo.head,
      lastReviewedSha: null,
      evidenceDir,
      openFindings: [],
      ...selectSeats({ tier: 1, paths, council: config.council, diffLines: 20 }),
      ...(args.includes('--inline-personas') ? { personas: loadPersonas() } : {}),
    });
  }
  writeFileSync(join(out, 'plans.json'), JSON.stringify(plans, null, 2));
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2));
  const agents = plans.reduce((sum, plan) => sum + plan.seats.length + plan.panel.length, 0);
  console.log(JSON.stringify({ plans: join(out, 'plans.json').replaceAll('\\', '/'), cases: plans.length, agents }));
  return 0;
}

async function grade(args) {
  const out = resolve(args[0]);
  const results = JSON.parse(readFileSync(args[1], 'utf8'));
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  const byId = new Map((await loadCases()).map((kase) => [kase.id, kase]));
  const grades = Object.entries(index).map(([key, id]) => gradeCase(byId.get(id), results[key]));
  const score = scoreCases(grades);
  console.log(JSON.stringify({ score, grades }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const run = { prepare, grade }[command];
  if (!run) {
    console.error('Usage: eval.mjs prepare <dir> [--split train|test] [--cases a,b] | grade <dir> <results.json>');
    process.exitCode = 2;
  } else {
    run(args).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
