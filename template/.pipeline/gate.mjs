#!/usr/bin/env node
// The merge gate.
//   node .pipeline/gate.mjs ci                  CI: evaluate from the event, publish a check run
//   node .pipeline/gate.mjs local [--pr N]      Local: evaluate and print; exit 1 unless mergeable
//   node .pipeline/gate.mjs classify [--base R] Print this branch's change hash and tier as JSON
//   node .pipeline/gate.mjs fresh [--base R]    With `freshness` on: exit 1 if this branch needs an update
//
// In CI this runs from the default branch through pull_request_target,
// issue_comment, workflow_run, and a push to the default branch or a schedule
// (which re-evaluate open PRs when `freshness` is on), so a PR can't change it. It fetches PR objects
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
import { freshnessOf, isStaleSummary } from './lib/freshness.mjs';
import { evaluateGate } from './lib/gate-core.mjs';
import { changeSet, git, rawChanges, readBlob, tryGit } from './lib/git.mjs';
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
//
// The markers depend on a gate run, which the workflow's concurrency group can
// cancel while it waits, so the gate also reads the record GitHub keeps itself:
// pushes to the head branch from the repository activity log, and body edits from
// the PR's edit history. Activity before the PR opened is the workflow relay rule,
// and doesn't count. A commit with no linked GitHub user (author null) is no one's.
export async function delegateInputs(client, repo, number, comments, { pr = null, config = null } = {}) {
  const commits = await client.list(`/repos/${repo}/pulls/${number}/commits?per_page=100`);
  const commitLogins = [
    ...new Set(commits.flatMap((commit) => [commit.author?.login, commit.committer?.login]).filter(Boolean)),
  ];
  const events = await client.list(`/repos/${repo}/issues/${number}/events?per_page=100`);
  const labelled = events
    .filter((event) => event.event === 'labeled' && event.label?.name === TOUCHED_LABEL && event.actor?.login === BOT)
    .map((event) => ({ kind: 'label', login: null, at: event.created_at }));
  // If GitHub's own records can't be read, a delegate's approval can't count, but
  // the gate still runs, so an admin's approval still works.
  let recorded = [];
  let historyUnreadable = false;
  if (pr && config) {
    try {
      recorded = await recordedTouches(client, repo, number, pr, config);
    } catch (error) {
      console.error(`Could not read the push and edit history of #${number}: ${error.message}`);
      historyUnreadable = true;
    }
  }
  return { commitLogins, touches: [...touchMarkers(comments), ...labelled, ...recorded], historyUnreadable };
}

const EDITS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){userContentEdits(first:100){nodes{editedAt editor{login ... on User{databaseId}}}}}}}';

async function recordedTouches(client, repo, number, pr, config) {
  const auth = authority(config);
  const opened = Date.parse(pr.created_at);
  const touches = [];
  if (pr.head?.repo?.full_name === repo) {
    const ref = encodeURIComponent(`refs/heads/${pr.head.ref}`);
    const activity = await client.list(`/repos/${repo}/activity?ref=${ref}&per_page=100`);
    for (const entry of activity) {
      const pushed = ['push', 'force_push'].includes(entry.activity_type);
      if (pushed && Date.parse(entry.timestamp) > opened && auth.delegateOfUser(entry.actor)) {
        touches.push({ kind: 'push', login: entry.actor.login, at: entry.timestamp });
      }
    }
  }
  const [owner, name] = repo.split('/');
  const response = await client.post('/graphql', { query: EDITS_QUERY, variables: { owner, name, number } });
  const edits = response?.data?.repository?.pullRequest?.userContentEdits?.nodes;
  if (!Array.isArray(edits)) throw new Error(`Could not read the edit history of #${number}`);
  for (const change of edits) {
    if (Date.parse(change.editedAt) > opened && auth.delegateOfUser({ login: change.editor?.login, id: change.editor?.databaseId })) {
      touches.push({ kind: 'body', login: change.editor.login, at: change.editedAt });
    }
  }
  return touches;
}

// pull_request_target carries who caused the event. A delegate that pushes to a
// PR, or edits its body, can't then approve it: the bot marks the PR for good.
export function touchOf(eventName, event, config) {
  if (eventName !== 'pull_request_target') return null;
  const sender = event.sender?.login;
  if (!sender || event.sender?.type === 'Bot' || !authority(config).delegateOfUser(event.sender)) return null;
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
// With a delegate configured, it also reads each issue's author and events, which
// a delegate's /decide needs.
async function citedDecision(client, repo, config, body, ctx = {}) {
  const issues = [...(body ?? '').matchAll(/^Decision:\s*#(\d+)\s*$/gim)].map((m) => m[1]);
  if (issues.length === 0) return false;
  const delegated = authority(config).delegates.length > 0;
  for (const issue of issues) {
    const comments = await client.list(`/repos/${repo}/issues/${issue}/comments?per_page=100`);
    const context = delegated ? { ...ctx, ...(await decisionContext(client, repo, issue)) } : ctx;
    if (!findDecision(comments, config, context)) return false;
  }
  return true;
}

export async function decisionContext(client, repo, number) {
  const issue = await client.get(`/repos/${repo}/issues/${number}`);
  const events = await client.list(`/repos/${repo}/issues/${number}/events?per_page=100`);
  return { issueAuthor: issue?.user?.login ?? null, events };
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
  const extra = delegated ? { ...(await delegateInputs(client, repo, number, comments, { pr, config })), ...suspension } : {};

  let verify;
  if (localEvidence) {
    verify = readLocalEvidence(hash, cwd);
  } else {
    const checkRuns = await client.list(`/repos/${repo}/commits/${headRef}/check-runs?per_page=100&filter=latest`);
    verify = pickCheck(checkRuns, config.verify.checkNames ?? ['verify']);
  }

  // Only with freshness configured: what main changed since this branch's base,
  // and which main that was, so a publish can tell if main moved since, and the
  // check can say which main it was evaluated against.
  let fresh = {};
  if (config.freshness) {
    const baseSha = git(['rev-parse', baseRef], cwd).trim();
    const freshness = freshnessOf(config.freshness, rawChanges(mergeBase, baseRef, cwd).map((c) => c.path), changes.map((c) => c.path));
    fresh = { freshness: { ...freshness, base: baseSha }, baseSha };
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
    ...fresh,
  };
}

const mainSha = async (client, repo, branch) => (await client.get(`/repos/${repo}/git/ref/heads/${branch}`))?.object?.sha ?? null;

export async function latestGate(client, repo, sha) {
  const runs = await client.list(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest&per_page=100`);
  return runs.filter((run) => run.name === CHECK_NAME && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0] ?? null;
}

const heldStale = (check) => check?.conclusion === 'failure' && isStaleSummary(check.output?.summary);

// Whether another run published this gate check after `since`.
export const publishedSince = (check, since) => Boolean(check) && Date.parse(check.started_at ?? check.completed_at) > Date.parse(since);

// With freshness on, a pass must hold for the main that is current when it goes
// out, or a branch that a merge made stale could stay green. So the run reads main
// before publishing a pass and again after it. If main moved since the evaluation,
// it evaluates again and publishes that, so the last writer is never stale.
// Anything but a pass publishes at once, since it can't merge. If main keeps
// moving, the newest evaluation goes out, and the run for the newest main, or the
// hourly re-check, follows it.
export async function publishFresh(client, repo, number, cwd, input, result, options = {}, again = null) {
  const evaluateAgain =
    again ??
    (async () => {
      const next = await gather({ client, repo, number, cwd });
      return { input: next, result: evaluateGate(next) };
    });
  if (!input.freshness) {
    await publish(client, repo, input, result, options);
    return { input, result };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (result.conclusion === 'success' && (await mainSha(client, repo, input.defaultBranch)) !== input.baseSha) {
      ({ input, result } = await evaluateAgain());
      continue;
    }
    await publish(client, repo, input, result, options);
    if (result.conclusion !== 'success' || (await mainSha(client, repo, input.defaultBranch)) === input.baseSha) return { input, result };
    ({ input, result } = await evaluateAgain());
  }
  await publish(client, repo, input, result, options);
  return { input, result };
}

// Main moved, or it's the hourly re-check. With freshness on, find each open PR
// whose freshness this main changes: stale now but not held as stale, or held as
// stale but no longer stale, as when main reverts the change it overlapped.
// Freshness comes from local git, so this costs one API call per open PR, and only
// those PRs are evaluated in full. Without freshness, nothing.
export async function mainMoved(client, repo, config, cwd = process.cwd(), { republish = reevaluate, since = new Date().toISOString(), freshnessOfPr = null } = {}) {
  if (!config.freshness) return { skipped: 'freshness is not configured' };
  const open = (await client.list(`/repos/${repo}/pulls?state=open&per_page=100`)).filter(
    (pr) => !pr.draft && pr.base?.ref === pr.base?.repo?.default_branch,
  );
  if (open.length === 0) return { reevaluated: [] };
  const fresh = freshnessOfPr ?? localFreshness(cwd, open[0].base.repo.default_branch, open.map((pr) => pr.number));
  const numbers = [];
  for (const pr of open) {
    const held = heldStale(await latestGate(client, repo, pr.head.sha));
    let stale;
    try {
      stale = fresh(pr.number).stale;
    } catch (error) {
      console.error(`Could not read the freshness of #${pr.number}: ${error.message}`);
      stale = !held;
    }
    if (stale !== held) numbers.push(pr.number);
  }
  return { reevaluated: await republish(client, repo, numbers, cwd, { since }) };
}

function localFreshness(cwd, defaultBranch, numbers) {
  const heads = numbers.map((n) => `+refs/pull/${n}/head:refs/pipeline/pr/${n}`);
  git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${defaultBranch}:refs/pipeline/base`, ...heads], cwd);
  return (number) => freshAt('refs/pipeline/base', `refs/pipeline/pr/${number}`, cwd);
}

// With freshness on, a commit may still carry a pass from before main moved: a
// branch pushed back to an earlier commit, or a new PR opened at one. So a run for
// a new head marks the gate in progress on it before evaluating anything.
export function evaluatingBody(pr, config, runId = process.env.GITHUB_RUN_ID) {
  const input = { pr: { head: pr.head.sha, url: pr.html_url }, config };
  const result = { status: 'in_progress', conclusion: null, title: 'Evaluating', summary: 'The gate is evaluating this commit against the current main.' };
  return checkRunBody(input, result, runId);
}

function readLocalEvidence(hash, cwd = process.cwd()) {
  const path = `${cwd}/.pipeline/evidence/${hash.slice(0, 12)}/full.json`;
  if (!existsSync(path)) return 'missing';
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  return evidence.ok ? 'success' : 'failure';
}

// A re-publish from post-merge, audit or decisions is marked as one, so the
// forged-gate check can tell it from a check that some other workflow wrote.
export function checkRunBody(input, result, runId = process.env.GITHUB_RUN_ID, { republish = false } = {}) {
  const body = {
    name: CHECK_NAME,
    head_sha: input.pr.head,
    status: result.status,
    details_url: input.pr.url,
    output: { title: result.title, summary: result.summary },
  };
  if (result.conclusion) body.conclusion = result.conclusion;
  // With a delegate configured, stamp the check with this run, so post-merge can
  // tell it from one a pushed workflow wrote. See lib/delegates.mjs.
  if (authority(input.config).delegates.length > 0 && runId) body.external_id = `${republish ? 'republish:' : ''}${runId}`;
  return body;
}

async function publish(client, repo, input, result, options) {
  await client.post(`/repos/${repo}/check-runs`, checkRunBody(input, result, undefined, options));
}

// Evaluate and publish again, for when state outside the PR changed: a delegate
// suspension voids approvals that already turned checks green, and with freshness
// on, main moved. With `since`, a PR whose gate another run published after that
// moment is left alone, since this evaluation may be the older one.
export async function reevaluate(client, repo, numbers, cwd = process.cwd(), { since = null } = {}) {
  const results = [];
  for (const number of numbers) {
    const pr = await client.get(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== 'open') continue;
    try {
      const gathered = await gather({ client, repo, number, cwd });
      if (since && publishedSince(await latestGate(client, repo, gathered.pr.head), since)) {
        results.push({ number, conclusion: 'skipped' });
        continue;
      }
      const { result } = await publishFresh(client, repo, number, cwd, gathered, evaluateGate(gathered), { republish: true });
      results.push({ number, conclusion: result.conclusion ?? result.status });
    } catch (error) {
      console.error(error);
      // Without checks: write this fails too. Say so, rather than throw from here.
      const runId = process.env.GITHUB_RUN_ID;
      await client
        .post(`/repos/${repo}/check-runs`, {
          name: CHECK_NAME,
          head_sha: pr.head.sha,
          status: 'completed',
          conclusion: 'failure',
          ...(runId ? { external_id: `republish:${runId}` } : {}),
          output: { title: 'Gate error', summary: 'The gate could not evaluate this PR. See the workflow log.' },
        })
        .catch((failure) => console.error(`Could not publish the gate error for #${number}: ${failure.message}`));
      results.push({ number, conclusion: 'error' });
    }
  }
  return results;
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
    historyUnreadable: input.historyUnreadable,
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
  const started = new Date().toISOString();
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

  if (eventName === 'push' || eventName === 'schedule') {
    // gate.yml runs on a push to the default branch, and hourly, from that branch.
    // The hourly run catches a PR that a failed push run left green.
    if (eventName === 'push' && event.ref !== `refs/heads/${event.repository?.default_branch}`) return 0;
    const outcome = await mainMoved(client, repo, parseConfig(readFileSync('pipeline.config.json', 'utf8')), process.cwd(), { since: started });
    console.log(JSON.stringify(outcome));
    return outcome.reevaluated?.some((r) => r.conclusion === 'error') ? 1 : 0;
  }

  const numbers = await resolvePrNumbers(eventName, event, client, repo);
  if (numbers.length === 0) console.log('No open PR for this event.');
  // This job runs on a checkout of the default branch, so its config is policy.
  // A delegate's touch is marked before evaluating, so this run already counts it.
  // A config that can't be read here fails in gather, per PR, as it always has.
  let policy = null;
  if (eventName === 'pull_request_target') {
    try {
      policy = parseConfig(readFileSync('pipeline.config.json', 'utf8'), { warn: () => {} });
    } catch {
      policy = null;
    }
  }
  const touch = policy ? touchOf(eventName, event, policy) : null;
  const newHead = Boolean(policy?.freshness) && ['opened', 'reopened', 'synchronize'].includes(event.action);
  let failed = false;
  for (const number of numbers) {
    const pr = await client.get(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== 'open') continue;
    try {
      if (newHead) await client.post(`/repos/${repo}/check-runs`, evaluatingBody(pr, policy));
      if (touch) await markTouch(client, repo, number, touch);
      const gathered = await gather({ client, repo, number, cwd: process.cwd() });
      const { input, result } = await publishFresh(client, repo, number, process.cwd(), gathered, evaluateGate(gathered));
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

// For a worker about to merge: does this branch need an update first? Policy
// comes from the base, as in the gate. Prints the freshness result as JSON.
export function freshAt(baseRef, headRef = 'HEAD', cwd = process.cwd()) {
  const configText = readBlob(baseRef, 'pipeline.config.json', cwd);
  if (configText === null) throw new Error(`pipeline.config.json is missing from ${baseRef}`);
  const config = parseConfig(configText, { warn: () => {} });
  if (!config.freshness) return { configured: false, stale: false };
  const { mergeBase, changes } = changeSet(baseRef, headRef, cwd);
  const mainPaths = rawChanges(mergeBase, baseRef, cwd).map((c) => c.path);
  return { configured: true, ...freshnessOf(config.freshness, mainPaths, changes.map((c) => c.path)) };
}

function runFresh(args) {
  const baseRef = arg(args, '--base') ?? 'origin/main';
  const remote = /^origin\/(.+)$/.exec(baseRef);
  if (remote) tryGit(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${remote[1]}:refs/remotes/origin/${remote[1]}`]);
  const result = freshAt(baseRef);
  console.log(JSON.stringify(result, null, 2));
  return result.stale ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'ci') return runCi();
  if (command === 'local') return runLocal(args);
  if (command === 'classify') return runClassify(args);
  if (command === 'fresh') return runFresh(args);
  console.error('Usage: gate.mjs ci | local [--pr N] [--evidence] | classify [--base REF] | fresh [--base REF]');
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
