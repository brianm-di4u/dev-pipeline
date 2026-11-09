#!/usr/bin/env node
// The merge gate.
//   node .pipeline/gate.mjs ci                  CI: evaluate from the event, publish a check run
//   node .pipeline/gate.mjs local [--pr N]      Local: evaluate and print; exit 1 unless mergeable
//   node .pipeline/gate.mjs classify [--base R] Print this branch's change hash and tier as JSON
//
// In CI this runs from the default branch through pull_request_target,
// issue_comment, and workflow_run, so a PR can't change it. It fetches PR objects
// but never checks them out or runs them, and treats all PR text as data.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { authority } from './lib/authority.mjs';
import { parseConfig } from './lib/config.mjs';
import {
  actorOf,
  approvedHash,
  delegateRefusals,
  findApproval,
  findDecision,
  isApproveCommand,
  parseVerdict,
  touchMarkers,
} from './lib/contract.mjs';
import { evaluateGate } from './lib/gate-core.mjs';
import { changeSet, git, readBlob, tryGit } from './lib/git.mjs';
import { cliClient, tokenClient } from './lib/github.mjs';
import { claimedRevert, verifyCleanRevert } from './lib/revert.mjs';
import { readRepoState } from './lib/state.mjs';
import { classify, scriptsChanged } from './lib/tier.mjs';

export const CHECK_NAME = 'pipeline/gate';
const BOT = 'github-actions[bot]';
export const TOUCHED_LABEL = 'pipeline:delegate-touched';

export async function resolvePrNumbers(eventName, event, client, repo) {
  switch (eventName) {
    case 'pull_request_target':
      return [event.pull_request.number];
    case 'issue_comment':
      return event.issue?.pull_request ? [event.issue.number] : [];
    case 'workflow_run': {
      const run = event.workflow_run;
      const direct = (run.pull_requests ?? []).map((pr) => pr.number);
      if (direct.length > 0) return direct;
      const linked = await client.list(`/repos/${repo}/commits/${run.head_sha}/pulls?per_page=100`);
      const open = linked.filter((pr) => pr.state === 'open').map((pr) => pr.number);
      if (open.length > 0) return open;
      // Fork PRs aren't linked from the run, so find them by branch.
      const owner = run.head_repository?.owner?.login;
      const prs = await client.list(`/repos/${repo}/pulls?state=open&per_page=100&head=${owner}:${run.head_branch}`);
      return prs.filter((pr) => pr.head.sha === run.head_sha).map((pr) => pr.number);
    }
    default:
      return [];
  }
}

export function pickCheck(checkRuns, names) {
  const verdicts = names.map((name) => {
    const runs = checkRuns
      .filter((run) => run.name === name && run.app?.slug === 'github-actions')
      .sort((a, b) => b.id - a.id);
    const latest = runs[0];
    if (!latest) return 'missing';
    if (latest.status !== 'completed') return 'pending';
    return latest.conclusion;
  });
  return verdicts.find((v) => v !== 'success') ?? 'success';
}

// What a delegate's approval depends on beyond the change itself: who is on the
// PR's commits, and whether a delegate pushed to it or edited its body. The bot
// marks a touch with a comment and a label. Anyone with write access can delete
// the comment or remove the label, but nobody can delete the `labeled` event, so
// that counts too.
export async function delegateInputs(client, repo, number, comments) {
  const commits = await client.list(`/repos/${repo}/pulls/${number}/commits?per_page=100`);
  const commitLogins = [
    ...new Set(commits.flatMap((commit) => [commit.author?.login, commit.committer?.login]).filter(Boolean)),
  ];
  const events = await client.list(`/repos/${repo}/issues/${number}/events?per_page=100`);
  const labelled = events
    .filter((event) => event.event === 'labeled' && event.label?.name === TOUCHED_LABEL && event.actor?.login === BOT)
    .map((event) => ({ kind: 'label', login: null, at: event.created_at }));
  return { commitLogins, touches: [...touchMarkers(comments), ...labelled] };
}

// pull_request_target carries who caused the event. A delegate that pushes to a
// PR, or edits its body, can't then approve it: the bot marks the PR for good.
export function touchOf(eventName, event, config) {
  if (eventName !== 'pull_request_target') return null;
  const sender = event.sender?.login;
  if (!sender || event.sender?.type === 'Bot' || !authority(config).delegateOf(sender)) return null;
  if (event.action === 'synchronize') return { kind: 'push', login: sender };
  if (event.action === 'edited' && event.changes?.body) return { kind: 'body', login: sender };
  return null;
}

export async function markTouch(client, repo, number, touch) {
  const what = touch.kind === 'push' ? 'pushed to' : 'edited the body of';
  await client.post(`/repos/${repo}/issues/${number}/comments`, {
    body: `Delegate ${touch.login} ${what} this PR, so no delegate approval of it counts from now on. An admin can still approve it.\n\n<!-- pipeline:delegate-touch kind=${touch.kind} login=${touch.login} -->`,
  });
  await client.post(`/repos/${repo}/issues/${number}/labels`, { labels: [TOUCHED_LABEL] });
}

// A delegate's /decide counts only with the suspension state, which `ctx` carries.
async function citedDecision(client, repo, config, body, ctx = {}) {
  const issues = [...(body ?? '').matchAll(/^Decision:\s*#(\d+)\s*$/gim)].map((m) => m[1]);
  if (issues.length === 0) return false;
  for (const issue of issues) {
    const comments = await client.list(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    if (!findDecision(comments, config, ctx)) return false;
  }
  return true;
}

export async function gather({ client, repo, number, cwd, localEvidence = false }) {
  const pr = await client.get(`/repos/${repo}/pulls/${number}`);
  const defaultBranch = pr.base.repo.default_branch;
  const baseRef = `refs/pipeline/base`;
  const headRef = pr.head.sha;
  git(
    [
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      `+refs/heads/${defaultBranch}:${baseRef}`,
      `+refs/pull/${number}/head:refs/pipeline/pr/${number}`,
    ],
    cwd,
  );

  // Policy always comes from the base branch, so a PR can't grade itself.
  const configText = readBlob(baseRef, 'pipeline.config.json', cwd);
  if (configText === null) throw new Error(`pipeline.config.json is missing from ${defaultBranch}`);
  const config = parseConfig(configText);

  const { mergeBase, changes, hash } = changeSet(baseRef, headRef, cwd);
  const scriptsChangedIn = scriptsChanged(changes, mergeBase, headRef, cwd);

  const claimed = claimedRevert(pr.body);
  const cleanRevert = claimed
    ? verifyCleanRevert({ claimed, changes, baseRef, config, cwd }).ok
    : false;

  const state = await readRepoState(client, repo, config, pr.body);
  // Only with a delegate configured does the gate read anything more than before.
  const delegated = authority(config).delegates.length > 0;
  const suspension = delegated ? { suspended: state.suspended, suspensions: state.suspensions } : {};
  const adrCited = await citedDecision(client, repo, config, pr.body, suspension);
  const comments = await client.list(`/repos/${repo}/issues/${number}/comments?per_page=100`);
  const extra = delegated ? { ...(await delegateInputs(client, repo, number, comments)), ...suspension } : {};

  let verify;
  if (localEvidence) {
    verify = readLocalEvidence(hash, cwd);
  } else {
    const checkRuns = await client.list(`/repos/${repo}/commits/${headRef}/check-runs?per_page=100&filter=latest`);
    verify = pickCheck(checkRuns, config.verify.checkNames ?? ['verify']);
  }

  return {
    pr: {
      number,
      author: pr.user.login,
      body: pr.body ?? '',
      draft: pr.draft,
      base: pr.base.ref,
      head: headRef,
      url: pr.html_url,
    },
    changes,
    hash,
    config,
    verify,
    comments,
    scriptsChangedIn,
    cleanRevert,
    adrCited,
    defaultBranch,
    mainRed: state.mainRed,
    citesMainRed: state.citesMainRed,
    breakerTripped: state.breakerTripped,
    ...extra,
  };
}

function readLocalEvidence(hash, cwd = process.cwd()) {
  const path = `${cwd}/.pipeline/evidence/${hash.slice(0, 12)}/full.json`;
  if (!existsSync(path)) return 'missing';
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  return evidence.ok ? 'success' : 'failure';
}

async function publish(client, repo, input, result) {
  const body = {
    name: CHECK_NAME,
    head_sha: input.pr.head,
    status: result.status,
    details_url: input.pr.url,
    output: { title: result.title, summary: result.summary },
  };
  if (result.conclusion) body.conclusion = result.conclusion;
  await client.post(`/repos/${repo}/check-runs`, body);
}

// One account can't be told apart from its agents, so every admin approval gets
// an immediate notification. The bot's @mention reaches the owner; their own
// comment doesn't. A delegate is its own account, so its approval is recorded
// without a ping, and one that doesn't count gets the reason.
export function approvalNotice(comment, input, result) {
  const short = input.hash.slice(0, 12);
  const auth = authority(input.config);
  const role = actorOf(comment, auth);
  if (role === 'admin') {
    if (!findApproval([comment], input.config.admins, input.hash)) return null;
    const mentions = input.config.admins.map((login) => `@${login}`).join(' ');
    return `${mentions} approval recorded for change \`${short}\`. If you didn't post it, close this PR and investigate.`;
  }
  if (role !== 'delegate' || !isApproveCommand(comment)) return null;
  const login = comment.user.login;
  if (!input.hash.startsWith(approvedHash(comment))) {
    return `The approval by ${login} is for different content. This PR's change is \`${short}\`.`;
  }
  const ctx = {
    flags: result?.delegate?.flags,
    author: input.pr.author,
    commitLogins: input.commitLogins,
    touches: input.touches,
    suspended: input.suspended,
    suspensions: input.suspensions,
  };
  const [refusal] = delegateRefusals([comment], auth, input.hash, ctx);
  if (refusal) return `The approval by ${login} doesn't count: ${refusal.reasons.join('; ')}.`;
  return `Delegate approval by ${login} recorded for \`${short}\`.`;
}

async function echoApproval(client, repo, input, event, result) {
  const comment = event.comment;
  if (!comment || event.action !== 'created') return;
  const body = approvalNotice(comment, input, result);
  if (!body) return;
  await client.post(`/repos/${repo}/issues/${input.pr.number}/comments`, { body });
}

async function runCi() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const client = tokenClient(process.env.GITHUB_TOKEN);

  if (eventName === 'merge_group') {
    // A queued PR already passed the gate. The queue's own CI run covers the rest.
    await client.post(`/repos/${repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: event.merge_group.head_sha,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'In merge queue', summary: 'This PR passed the gate before it was queued.' },
    });
    return 0;
  }

  const numbers = await resolvePrNumbers(eventName, event, client, repo);
  if (numbers.length === 0) console.log('No open PR for this event.');
  // This job runs on a checkout of the default branch, so its config is policy.
  // A delegate's touch is marked before evaluating, so this run already counts it.
  // A config that can't be read here fails in gather, per PR, as it always has.
  let touch = null;
  if (eventName === 'pull_request_target') {
    try {
      touch = touchOf(eventName, event, parseConfig(readFileSync('pipeline.config.json', 'utf8'), { warn: () => {} }));
    } catch {
      touch = null;
    }
  }
  let failed = false;
  for (const number of numbers) {
    const pr = await client.get(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== 'open') continue;
    try {
      if (touch) await markTouch(client, repo, number, touch);
      const input = await gather({ client, repo, number, cwd: process.cwd() });
      const result = evaluateGate(input);
      await publish(client, repo, input, result);
      report(number, result);
      if (eventName === 'issue_comment') {
        // A failed notification must not change the merge decision, which is
        // already published. It fails the job instead, so it stays visible.
        await echoApproval(client, repo, input, event, result).catch((error) => {
          failed = true;
          console.error(`Could not post the approval notice: ${error.message}`);
        });
      }
    } catch (error) {
      // Fail closed: an error must never read as a pass.
      failed = true;
      console.error(error);
      await client.post(`/repos/${repo}/check-runs`, {
        name: CHECK_NAME,
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'Gate error', summary: 'The gate could not evaluate this PR. See the workflow log.' },
      });
    }
  }
  return failed ? 1 : 0;
}

function report(number, result) {
  const text = `#${number}: ${result.title} (${result.conclusion ?? result.status})\n${result.summary}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function currentRepo() {
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}

async function runLocal(args) {
  const number =
    arg(args, '--pr') ??
    execFileSync('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], { encoding: 'utf8' }).trim();
  const useEvidence = args.includes('--evidence');
  const input = await gather({
    client: cliClient(),
    repo: currentRepo(),
    number: Number(number),
    cwd: process.cwd(),
    localEvidence: useEvidence,
  });
  const result = evaluateGate(input);
  report(number, result);
  return result.conclusion === 'success' ? 0 : 1;
}

function runClassify(args) {
  const config = parseConfig(readFileSync('pipeline.config.json', 'utf8'));
  const baseRef = arg(args, '--base') ?? 'origin/main';
  const headRef = 'HEAD';
  const { mergeBase, changes, hash } = changeSet(baseRef, headRef);
  const author = arg(args, '--author') ?? config.admins[0];
  const { tier, reasons } = classify({
    changes,
    config,
    author,
    scriptsChangedIn: scriptsChanged(changes, mergeBase, headRef),
  });
  const lines = tryGit(['diff', '--shortstat', mergeBase, headRef])?.trim() ?? '';
  console.log(
    JSON.stringify(
      { hash, shortHash: hash.slice(0, 12), tier, reasons, paths: changes.map((c) => c.path), shortstat: lines },
      null,
      2,
    ),
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'ci') return runCi();
  if (command === 'local') return runLocal(args);
  if (command === 'classify') return runClassify(args);
  console.error('Usage: gate.mjs ci | local [--pr N] [--evidence] | classify [--base REF]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

export { parseVerdict };
