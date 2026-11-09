#!/usr/bin/env node
// Council bookkeeping for one branch. The council skill drives this.
//
//   council.mjs plan --intent "..." [--out-of-scope "..."]   What happens next, as JSON
//                    [--decision <issue>]                    A decision record citing that issue
//                    [--worker <model>]                      The model that wrote the change
//   council.mjs record <result.json>                         Record a round's result
//   council.mjs resolve <id> <fixed|wrong|intentional|wont-matter|deferred> ["reason"]
//   council.mjs accept-growth "reason"                       Accept justified diff growth
//   council.mjs step-back                                    Record a re-approach
//   council.mjs verdict                                      Print the verdict block for the PR body
//
// The ledger lives in .pipeline/runs/, which is gitignored.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MODEL_NAME, parseConfig } from './lib/config.mjs';
import { findDecision, renderVerdict } from './lib/contract.mjs';
import { changeSet, git, tryGit } from './lib/git.mjs';
import {
  buildVerdict,
  emptyLedger,
  nextStep,
  recordRound,
  resolveFinding,
  selectSeats,
} from './lib/ledger.mjs';
import { loadPersonas } from './lib/personas.mjs';
import { classify, scriptsChanged } from './lib/tier.mjs';

const BASE = 'origin/main';
function branch() {
  const name = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  // A reviewer running in a shared checkout can leave it detached. Stop rather than
  // start a second ledger, or commit to nowhere.
  if (name === 'HEAD') throw new Error('HEAD is detached. Check out your branch first.');
  return name.replaceAll('/', '__');
}
const ledgerPath = () => join('.pipeline', 'runs', `${branch()}.json`);

function loadLedger() {
  const path = ledgerPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : emptyLedger();
}

function saveLedger(ledger) {
  mkdirSync(join('.pipeline', 'runs'), { recursive: true });
  writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`);
}

// The gate puts a decision record at T0 when the PR body cites an issue carrying a /decide that
// counts: an admin's, or a delegate's within its grant. The body doesn't exist yet when the council
// plans, so `plan --decision <issue>` names the issue, and it is checked the same way here, except
// for delegate suspension, which this can't see. The gate checks that again, and it is the authority.
function decided(issues, config) {
  if (issues.length === 0) return false;
  return issues.every((issue) => {
    const pages = JSON.parse(
      execFileSync('gh', ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${issue}/comments?per_page=100`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return findDecision(pages.flat(), config, { ignoreSuspension: true }) !== null;
  });
}

// After a rebase the reviewed commit is off this branch, and a diff from it would also show
// everything main gained since. Use its rebased copy, found by the same change hash, or failing
// that the merge base, so the round sees the whole change rather than someone else's.
function reviewedBase(last, mergeBase) {
  if (!last?.sha) return null;
  if (tryGit(['merge-base', '--is-ancestor', last.sha, 'HEAD']) !== null) return last.sha;
  const commits = (tryGit(['rev-list', `${mergeBase}..HEAD`]) ?? '').split('\n').filter(Boolean);
  return commits.find((sha) => changeSet(BASE, sha).hash === last.hash) ?? mergeBase;
}

function context() {
  const config = parseConfig(readFileSync('pipeline.config.json', 'utf8'));
  const { mergeBase, changes, hash } = changeSet(BASE, 'HEAD');
  const { tier, reasons } = classify({
    changes,
    config,
    author: config.admins[0],
    scriptsChangedIn: scriptsChanged(changes, mergeBase, 'HEAD'),
    adrCited: decided(loadLedger().decisions ?? [], config),
  });
  const shortstat = tryGit(['diff', '--shortstat', mergeBase, 'HEAD']) ?? '';
  const diffLines = [...shortstat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return { config, mergeBase, changes, hash, tier, reasons, diffLines };
}

function evidence(hash) {
  const dir = join('.pipeline', 'evidence', hash.slice(0, 12));
  const path = join(dir, 'full.json');
  if (!existsSync(path)) return { ok: false, dir };
  return { ok: JSON.parse(readFileSync(path, 'utf8')).ok === true, dir };
}

function plan(args) {
  const cited = args.flatMap((arg, i) => (args[i - 1] === '--decision' ? [arg.replace(/^#/, '')] : []));
  if (cited.length > 0) {
    if (!cited.every((issue) => /^\d+$/.test(issue))) throw new Error('--decision takes an issue number.');
    saveLedger({ ...loadLedger(), decisions: cited });
  }
  const worker = option(args, '--worker');
  if (worker !== null) {
    if (!MODEL_NAME.test(worker)) throw new Error('--worker takes a model name.');
    saveLedger({ ...loadLedger(), worker });
  }
  const ctx = context();
  const ledger = loadLedger();
  const tier = ledger.raise ? Math.max(ctx.tier, 2) : ctx.tier;
  const proof = evidence(ctx.hash);
  const cleanTree = !tryGit(['status', '--porcelain'])?.trim();
  const step = nextStep({
    ledger,
    tier,
    hash: ctx.hash,
    council: ctx.config.council,
    cleanTree,
    evidenceOk: proof.ok,
    diffLines: ctx.diffLines,
  });
  const output = { ...step, reasons: ctx.reasons };
  if (step.status === 'review') {
    const last = ledger.rounds.at(-1);
    const selection = selectSeats({
      tier,
      paths: ctx.changes.map((c) => c.path),
      council: ctx.config.council,
      diffLines: ctx.diffLines,
    });
    Object.assign(output, {
      ...selection,
      seats: step.mode === 'confirm' ? [] : selection.seats,
      head: git(['rev-parse', 'HEAD']).trim(),
      mergeBase: ctx.mergeBase,
      lastReviewedSha: reviewedBase(last, ctx.mergeBase),
      diffLines: ctx.diffLines,
      evidenceDir: resolve(proof.dir).replaceAll('\\', '/'),
      maxNits: ctx.config.council.maxNits ?? 5,
      intent: option(args, '--intent') ?? ledger.intent ?? null,
      outOfScope: option(args, '--out-of-scope') ?? ledger.outOfScope ?? null,
      openFindings: ledger.findings
        .filter((f) => f.status !== 'pre-existing')
        .map(({ id, severity, class: bugClass, file, line, claim, status }) => ({ id, severity, class: bugClass, file, line, claim, status })),
    });
    if (args.includes('--inline-personas')) output.personas = loadPersonas();
    // Normally reviewers get disposable worktrees. --cwd pins them to a folder instead,
    // for hosts where the session isn't running in this repo.
    if (args.includes('--cwd')) output.cwd = resolve(option(args, '--cwd')).replaceAll('\\', '/');
    ledger.plannedHead = output.head;
    if (output.intent) ledger.intent = output.intent;
    if (output.outOfScope) ledger.outOfScope = output.outOfScope;
    saveLedger(ledger);
    if (!output.intent) {
      output.status = 'needs-intent';
      output.message = 'State the intent: council.mjs plan --intent "what this change is for"';
    }
  }
  console.log(JSON.stringify(output, null, 2));
  return 0;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function record([file]) {
  const ctx = context();
  const ledger = loadLedger();
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const head = git(['rev-parse', 'HEAD']).trim();
  if (ledger.plannedHead && ledger.plannedHead !== head) {
    console.error(`HEAD moved during the round, from ${ledger.plannedHead} to ${head}. Those reviewers looked at something else, so plan again.`);
    return 1;
  }
  const step = nextStep({
    ledger,
    tier: ledger.raise ? Math.max(ctx.tier, 2) : ctx.tier,
    hash: ctx.hash,
    council: ctx.config.council,
    cleanTree: true,
    evidenceOk: true,
    diffLines: ctx.diffLines,
  });
  if (step.status !== 'review') {
    console.error(`Nothing to record: ${step.status}. ${step.message ?? ''}`);
    return 1;
  }
  const outcome = recordRound(ledger, {
    mode: step.mode,
    round: step.round,
    hash: ctx.hash,
    sha: git(['rev-parse', 'HEAD']).trim(),
    diffLines: ctx.diffLines,
    result: { ...result, maxNits: ctx.config.council.maxNits },
  });
  saveLedger(ledger);
  console.log(
    JSON.stringify(
      {
        round: step.round,
        mode: step.mode,
        complete: outcome.complete,
        missing: result.missing ?? [],
        answerThese: outcome.added.map(({ id, severity, class: bugClass, file: f, line, claim, fix }) => ({
          id, severity, class: bugClass, file: f, line, claim, fix,
        })),
        repeatsDropped: outcome.repeats.length,
        nitsDropped: outcome.droppedNits.length,
        raise: ledger.raise,
      },
      null,
      2,
    ),
  );
  return 0;
}

function resolveCommand([id, disposition, reason]) {
  const ledger = loadLedger();
  const finding = resolveFinding(ledger, id, disposition, reason);
  saveLedger(ledger);
  console.log(`${finding.id}: ${finding.disposition}`);
  return 0;
}

function verdict() {
  const ctx = context();
  const ledger = loadLedger();
  const built = buildVerdict({ ledger, tier: ctx.tier, hash: ctx.hash });
  console.log(renderVerdict(built));
  return 0;
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  plan: () => plan(args),
  record: () => record(args),
  resolve: () => resolveCommand(args),
  verdict,
  'accept-growth': () => {
    if (!args[0]) throw new Error('Give a reason.');
    const ledger = loadLedger();
    ledger.growthAccepted = args[0];
    saveLedger(ledger);
    return 0;
  },
  'step-back': () => {
    const ledger = loadLedger();
    ledger.steppedBack = true;
    saveLedger(ledger);
    return 0;
  },
};

if (!commands[command]) {
  console.error(`Usage: council.mjs <${Object.keys(commands).join('|')}>`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = commands[command]();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
