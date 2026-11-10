#!/usr/bin/env node
// The gardener's inbox: everything waiting on a human-level call, as one JSON
// document. It keeps no state of its own, like `autopilot.mjs next`. The
// `gardener` skill drives it.
//
//   garden.mjs inbox           Print the inbox
//   garden.mjs record daily    Record that today's gardening pass is done
//
// PRs go through the gate's own gather and evaluateGate, so what the inbox says a
// delegate may approve is exactly what the gate will accept.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gather } from './gate.mjs';
import { authority } from './lib/authority.mjs';
import { parseConfig } from './lib/config.mjs';
import { evaluateGate } from './lib/gate-core.mjs';
import { readBlob, tryGit } from './lib/git.mjs';
import { cliClient } from './lib/github.mjs';
import { countMatches, decisionItem, prItem, recurringFindings, staleBranches, stalePrs } from './lib/inbox.mjs';
import { readRepoState } from './lib/state.mjs';

const RUN_PATH = join('.pipeline', 'runs', 'garden.json');
const DAY = 24 * 60 * 60 * 1000;

export function loadRun(path = RUN_PATH) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

export function dailyPassDue(run, now) {
  return (run.lastDailyPass ?? '').slice(0, 10) !== now.toISOString().slice(0, 10);
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const gateCheck = (runs) =>
  runs.filter((run) => run.name === 'pipeline/gate' && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0] ?? null;

async function evaluatePr(client, repo, number) {
  return evaluateGate(await gather({ client, repo, number, cwd: process.cwd() }));
}

async function heldPrs(client, repo, open, evaluate, login) {
  const items = [];
  for (const pr of open.filter((candidate) => !candidate.draft)) {
    const runs = await client.list(`/repos/${repo}/commits/${pr.head.sha}/check-runs?check_name=pipeline%2Fgate&filter=latest&per_page=100`);
    if (gateCheck(runs)?.conclusion !== 'action_required') continue;
    try {
      const result = await evaluate(client, repo, pr.number);
      // A branch that needs an update from main is a worker's to fix, not a call to make.
      if (result.freshness?.stale) continue;
      items.push(prItem(pr, result, login));
    } catch (error) {
      items.push({ number: pr.number, title: pr.title, url: pr.html_url, error: error.message });
    }
  }
  return items;
}

function remoteBranches() {
  tryGit(['fetch', '--prune', '--quiet', 'origin']);
  const out = tryGit(['for-each-ref', 'refs/remotes/origin', '--format=%(refname:lstrip=3)%09%(committerdate:iso-strict)']) ?? '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, date] = line.split('\t');
      return { name, date };
    })
    .filter((ref) => ref.name !== 'HEAD');
}

// Optional, per project: `garden.counts` names files and a pattern to count,
// such as quarantined tests, compared with a week ago on the default branch.
function counts(config, defaultBranch) {
  const ref = `origin/${defaultBranch}`;
  const weekAgo = tryGit(['rev-list', '-1', '--before=7.days.ago', ref])?.trim() || null;
  return (config.garden?.counts ?? []).map(({ name, paths = [], pattern }) => {
    const at = (commit) => (commit ? countMatches(paths.map((path) => readBlob(commit, path)), pattern) : null);
    const now = at(ref);
    const before = at(weekAgo);
    return { name, now, weekAgo: before, growth: before === null ? null : now - before };
  });
}

// `evaluate`, `branches` and `projectCounts` read the local clone. Tests pass their own.
export async function buildInbox({
  client,
  repo,
  config,
  now,
  login,
  // The session's numeric user id. With an `id` in the grant, it must match.
  userId = null,
  evaluate = evaluatePr,
  branches = remoteBranches,
  projectCounts = counts,
}) {
  const auth = authority(config);
  const state = await readRepoState(client, repo, config);
  const suspension = auth.delegates.length > 0 ? { suspended: state.suspended, suspensions: state.suspensions } : {};
  const open = await client.list(`/repos/${repo}/pulls?state=open&per_page=100`);
  const prs = await heldPrs(client, repo, open, evaluate, login);

  const decisionIssues = (await client.list(`/repos/${repo}/issues?state=open&labels=decision-needed&per_page=100`)).filter(
    (issue) => !issue.pull_request,
  );
  const decisions = [];
  for (const issue of decisionIssues) {
    const comments = await client.list(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
    const events = await client.list(`/repos/${repo}/issues/${issue.number}/events?per_page=100`);
    decisions.push(decisionItem(issue, comments, config, suspension, events));
  }

  const escalations = (await client.list(`/repos/${repo}/issues?state=open&labels=admin-needed&per_page=100`))
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url, updated: issue.updated_at }));

  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const merged = (await client.list(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)).filter(
    (pr) => pr.merged_at && pr.merged_at >= since,
  );
  const defaultBranch = open[0]?.base?.repo?.default_branch ?? 'main';
  const openHeads = open.filter((pr) => pr.head?.repo?.full_name === repo).map((pr) => pr.head.ref);

  const named = auth.delegateOf(login);
  // A grant with an id is this session's only if the account is that one.
  const grant = named && named.id !== null && named.id !== userId ? null : named;
  return {
    login,
    delegate: grant,
    ...(named && !grant ? { error: `This session's account id is ${userId ?? 'unknown'}, not ${named.login}'s configured id ${named.id}.` } : {}),
    state: {
      mainRed: state.mainRed,
      redIssue: state.redIssue,
      breakerTripped: state.breakerTripped,
      breakerIssue: state.breakerIssue ?? null,
      delegateRearmOk: state.delegateRearmOk ?? false,
      suspended: state.suspended ?? false,
    },
    prs,
    decisions,
    escalations,
    hygiene: {
      recurringFindings: recurringFindings(merged),
      stalePrs: stalePrs(open, now),
      staleBranches: staleBranches(branches(), openHeads, defaultBranch, now),
      counts: projectCounts(config, defaultBranch),
    },
    dailyPassDue: dailyPassDue(loadRun(), now),
  };
}

// Policy comes from the default branch, as it does for the gate, so a change in
// this clone's working tree can't widen what the inbox calls actionable.
export async function baseConfig(client, repo, defaultBranch) {
  const file = await client.get(`/repos/${repo}/contents/pipeline.config.json?ref=${encodeURIComponent(defaultBranch)}`);
  return parseConfig(Buffer.from(file.content, 'base64').toString('utf8'));
}

async function inbox() {
  try {
    const { nameWithOwner: repo, defaultBranchRef } = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']));
    const [login, id] = gh(['api', 'user', '--jq', '[.login, .id] | @tsv']).split('\t');
    const client = cliClient();
    const config = await baseConfig(client, repo, defaultBranchRef.name);
    const result = await buildInbox({ client, repo, config, now: new Date(), login, userId: Number(id) });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    // A failed read isn't an empty inbox. Say so.
    console.log(JSON.stringify({ error: `Could not read GitHub: ${error.message}. This is not an empty inbox.` }, null, 2));
    return 1;
  }
}

function record([what]) {
  if (what !== 'daily') {
    console.error('Usage: garden.mjs record daily');
    return 2;
  }
  mkdirSync(join('.pipeline', 'runs'), { recursive: true });
  writeFileSync(RUN_PATH, `${JSON.stringify({ ...loadRun(), lastDailyPass: new Date().toISOString() }, null, 2)}\n`);
  console.log('Recorded the daily gardening pass.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inbox') {
    inbox().then((code) => {
      process.exitCode = code;
    });
  } else if (command === 'record') {
    process.exitCode = record(args);
  } else {
    console.error('Usage: garden.mjs inbox | record daily');
    process.exitCode = 2;
  }
}
