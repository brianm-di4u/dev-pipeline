#!/usr/bin/env node
// What should autopilot do next? It reads GitHub and prints one JSON decision.
//
//   autopilot.mjs next                       Decide the next action
//   autopilot.mjs record <state> [issue]     Record started | merged | failed | parked | decision
//
// Run records live in .pipeline/runs/autopilot.json. PR budgets are computed from
// GitHub itself, so a restart can't reset them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { cliClient } from './lib/github.mjs';
import { nextAction, recordOutcome } from './lib/queue.mjs';
import { hasRearm } from './lib/contract.mjs';

const RUN_PATH = join('.pipeline', 'runs', 'autopilot.json');
const BOT = encodeURIComponent('github-actions[bot]');

function loadRun() {
  return existsSync(RUN_PATH) ? JSON.parse(readFileSync(RUN_PATH, 'utf8')) : { consecutiveFailures: 0, history: [] };
}

function saveRun(run) {
  mkdirSync(join('.pipeline', 'runs'), { recursive: true });
  writeFileSync(RUN_PATH, `${JSON.stringify(run, null, 2)}\n`);
}

async function next() {
  // Re-read config every run, and fail rather than run on assumptions.
  const config = loadConfig();
  const run = loadRun();
  const now = new Date();
  let state;
  try {
    const client = cliClient();
    const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' }).trim();
    const issues = await client.list(`/repos/${repo}/issues?state=open&labels=ready&per_page=100`);
    const red = await client.list(`/repos/${repo}/issues?state=open&labels=pipeline:main-red&creator=${BOT}&per_page=10`);
    const breakers = await client.list(`/repos/${repo}/issues?state=all&labels=pipeline:breaker&creator=${BOT}&per_page=10`);
    const latest = breakers.sort((a, b) => b.number - a.number)[0];
    let breakerTripped = false;
    if (latest) {
      breakerTripped =
        latest.state === 'open' ||
        !hasRearm(await client.list(`/repos/${repo}/issues/${latest.number}/comments?per_page=100`), config.admins);
    }
    const pulls = await client.list(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50`);
    const open = await client.list(`/repos/${repo}/pulls?state=open&base=main&per_page=50`);
    const openOwnPrs = open
      .filter((pr) => config.admins.includes(pr.user.login) && !pr.labels.some((l) => ['blocked:decision', 'parked'].includes(l.name)))
      .map((pr) => pr.number);
    state = { issues, mainRed: red.length > 0, redIssue: red[0]?.number ?? null, breakerTripped, merges: pulls, openOwnPrs };
  } catch (error) {
    state = { sourceError: error.message, issues: [], merges: [], openOwnPrs: [] };
  }
  const decision = nextAction({ ...state, config, run, now });
  console.log(JSON.stringify({ ...decision, redIssue: state.redIssue ?? undefined }, null, 2));
  return 0;
}

function record(args) {
  const [state, issue] = args;
  const run = recordOutcome(loadRun(), { state, issue: issue ?? null, at: new Date().toISOString() });
  saveRun(run);
  console.log(`Recorded ${state}. Consecutive failures: ${run.consecutiveFailures}.`);
  return 0;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'next') {
  next().then((code) => { process.exitCode = code; });
} else if (command === 'record') {
  process.exitCode = record(args);
} else {
  console.error('Usage: autopilot.mjs next | record <state> [issue]');
  process.exitCode = 2;
}
