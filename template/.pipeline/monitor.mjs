#!/usr/bin/env node
// Detection and notification, run by workflows as github-actions[bot].
//
//   monitor.mjs post-merge --result <success|failure|...>   After verify on main
//   monitor.mjs issue-event                                 Decisions and re-arming
//   monitor.mjs audit                                       Is protection still on?
//   monitor.mjs digest                                      The weekly digest
//
// State lives in bot-authored issues, which agents can't forge, since they can't
// post as github-actions[bot]. A bot @mention also reaches the owner when their own
// account's actions wouldn't.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateBreaker } from './lib/breaker.mjs';
import { authority } from './lib/authority.mjs';
import { loadConfig } from './lib/config.mjs';
import {
  actorOf,
  decisionProblems,
  findDecision,
  hasRearm,
  isDecideCommand,
  parseDecisionClass,
  recordedClass,
  renderClassMarker,
} from './lib/contract.mjs';
import { buildDigest, renderDigest } from './lib/digest.mjs';
import { tokenClient } from './lib/github.mjs';

const BOT = 'github-actions[bot]';
const encodedBot = encodeURIComponent(BOT);
const GITHUB_ACTIONS_APP_ID = 15368;

const LABELS = {
  'pipeline:main-red': 'b60205',
  'pipeline:breaker': 'b60205',
  'pipeline:audit': 'b60205',
  'pipeline:digest': '0e8a16',
  'decision-needed': 'fbca04',
  decided: '0e8a16',
};

const mentions = (config) => config.admins.map((login) => `@${login}`).join(' ');

async function ensureLabel(client, repo, name) {
  await client.post(`/repos/${repo}/labels`, { name, color: LABELS[name] ?? 'ededed' }).catch(() => {});
}

async function botIssues(client, repo, label, state = 'open') {
  return client.list(`/repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&creator=${encodedBot}&per_page=100`);
}

async function openIssue(client, repo, label, title, body) {
  await ensureLabel(client, repo, label);
  return client.post(`/repos/${repo}/issues`, { title, body, labels: [label] });
}

export async function checkBreaker(client, repo, config) {
  const breakerIssues = (await botIssues(client, repo, 'pipeline:breaker', 'all')).sort((a, b) => b.number - a.number);
  const latest = breakerIssues[0];
  if (latest?.state === 'open') return { tripped: true, alreadyOpen: true };

  const merges = (await client.list(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`)).filter(
    (pr) => pr.merged_at,
  );
  const redIssues = await botIssues(client, repo, 'pipeline:main-red', 'all');
  const result = evaluateBreaker({ merges, redIssues, config, since: latest?.closed_at ?? null });

  if (result.tripped) {
    await openIssue(
      client,
      repo,
      'pipeline:breaker',
      'Circuit breaker tripped: T1 auto-merge is suspended',
      [
        `${mentions(config)} ${result.failures} failures in the last ${result.window} ordinary merges, against a limit of ${result.limit}.`,
        '',
        `- Reverted PRs: ${result.reverted.map((n) => `#${n}`).join(', ') || 'none'}`,
        `- Red-main issues: ${result.red.map((n) => `#${n}`).join(', ') || 'none'}`,
        '',
        'T1 changes now need your approval. Agents should find out why this keeps happening before shipping more.',
        '',
        'When you are satisfied, comment `/rearm` on this issue.',
      ].join('\n'),
    );
  }
  return result;
}

async function postMerge(client, repo, config, args) {
  const result = args[args.indexOf('--result') + 1];
  const sha = process.env.GITHUB_SHA;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const open = await botIssues(client, repo, 'pipeline:main-red');

  if (result === 'success') {
    for (const issue of open) {
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, { body: `Main is green again at ${sha}.` });
      await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
    }
  } else if (open.length === 0) {
    await openIssue(
      client,
      repo,
      'pipeline:main-red',
      `Main is red at ${sha.slice(0, 7)}`,
      [
        `${mentions(config)} \`verify\` ${result === 'failure' ? 'failed' : `ended as ${result}`} on main: ${runUrl}`,
        '',
        `T1 merges are blocked until main is green. Agents: reverting or fixing this comes before anything else. See docs/ROLLBACK.md, and cite this issue in the fix with a line reading \`Fixes-main-red: #<this issue>\`.`,
      ].join('\n'),
    );
  }
  const breaker = await checkBreaker(client, repo, config);
  console.log(JSON.stringify({ result, breaker }));
}

const ANSWER = 'Answer with a comment containing only `/decide <option>`.';

// With a delegate configured, the bot records the class when the issue is first
// labelled, and only pings the admins for a class no delegate may decide.
async function decisionNotice(client, repo, config, auth, issue) {
  const comments = await client.list(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
  const recorded = recordedClass(comments);
  const cls = recorded ? recorded.class : parseDecisionClass(issue.body);
  const marker = recorded ? '' : `\n\n${renderClassMarker(cls)}`;
  const deciders = cls ? auth.delegates.filter((grant) => grant.decide.includes(cls)).map((grant) => grant.login) : [];
  if (deciders.length > 0) {
    return `A ${cls} decision is needed here. A delegate (${deciders.join(', ')}) or an admin can decide it. ${ANSWER}${marker}`;
  }
  const who = cls
    ? `This is a ${cls} decision, so only an admin can make it.`
    : 'Its class is missing or unclear, so only an admin can make it.';
  return `${mentions(config)} a decision is needed here. ${who} ${ANSWER}${marker}`;
}

// The gate is the authority on whether a delegate's /decide counts. This only
// labels the issue, and tells the delegate when it doesn't count.
async function delegateDecision(client, repo, auth, issue, comment, ctx) {
  const comments = await client.list(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
  const problems = decisionProblems(comment, auth, comments, ctx);
  if (problems.length > 0) {
    await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
      body: `The decision by ${comment.user.login} doesn't count: ${problems.join('; ')}.`,
    });
    return;
  }
  const decision = findDecision(comments, auth, ctx);
  await ensureLabel(client, repo, 'decided');
  await client.post(`/repos/${repo}/issues/${issue.number}/labels`, { labels: ['decided'] });
  await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
    body: `Delegate decision by ${comment.user.login} recorded: \`${decision?.option ?? '?'}\` (${decision?.class ?? 'unclassified'}).`,
  });
}

// `ctx` carries the delegate suspension state. Without it, a delegate's /decide
// doesn't count.
export async function issueEvent(client, repo, config, eventName, event, ctx = {}) {
  const issue = event.issue;
  if (!issue || issue.pull_request) return;
  const labels = (issue.labels ?? []).map((label) => label.name);
  const auth = authority(config);

  if (eventName === 'issues') {
    if (event.action === 'labeled' && event.label?.name === 'decision-needed') {
      const body =
        auth.delegates.length > 0
          ? await decisionNotice(client, repo, config, auth, issue)
          : `${mentions(config)} a decision is needed here. ${ANSWER}`;
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, { body });
    }
    return;
  }

  const comment = event.comment;
  if (event.action !== 'created' || !comment) return;

  if (labels.includes('decision-needed') && findDecision([comment], config.admins)) {
    await ensureLabel(client, repo, 'decided');
    await client.post(`/repos/${repo}/issues/${issue.number}/labels`, { labels: ['decided'] });
  } else if (labels.includes('decision-needed') && actorOf(comment, auth) === 'delegate' && isDecideCommand(comment)) {
    await delegateDecision(client, repo, auth, issue, comment, ctx);
  }

  if (labels.includes('pipeline:breaker') && issue.user?.login === BOT && hasRearm([comment], config.admins)) {
    await client.post(`/repos/${repo}/issues/${issue.number}/comments`, { body: 'Re-armed. T1 auto-merge is back on, and the failure count starts over.' });
    await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
  }
}

export function auditProblems(branch) {
  const problems = [];
  const required = branch.protection?.required_status_checks;
  if (!branch.protected || !branch.protection?.enabled) problems.push('The default branch is not protected.');
  const pinned = required?.checks?.some((c) => c.context === 'pipeline/gate' && c.app_id === GITHUB_ACTIONS_APP_ID);
  if (!pinned) problems.push('pipeline/gate is not required, or is no longer pinned to GitHub Actions.');
  if (required?.enforcement_level !== 'everyone') problems.push('Protection no longer applies to admins.');
  return problems;
}

async function audit(client, repo, config) {
  const info = await client.get(`/repos/${repo}`);
  const branch = await client.get(`/repos/${repo}/branches/${info.default_branch}`);
  const problems = auditProblems(branch);
  const open = await botIssues(client, repo, 'pipeline:audit');
  console.log(problems.length ? problems.join('\n') : 'Protection is intact.');
  if (problems.length > 0 && open.length === 0) {
    await openIssue(
      client,
      repo,
      'pipeline:audit',
      'Branch protection changed',
      [
        `${mentions(config)} the pipeline's protection on this repo has changed:`,
        '',
        ...problems.map((p) => `- ${p}`),
        '',
        'If you did not do this, an agent or a stolen token may have. Run `pipeline protect` to restore it.',
      ].join('\n'),
    );
  }
  if (problems.length === 0) {
    for (const issue of open) await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
  }
}

async function digest(client, repo, config) {
  const now = new Date();
  const data = await buildDigest({ client, repo, config, now, botIssues });
  const body = renderDigest(data, config);
  const week = now.toISOString().slice(0, 10);
  const created = await openIssue(client, repo, 'pipeline:digest', `Weekly digest: ${week}`, `${mentions(config)}\n\n${body}`);
  // Keep only the newest digest open. A just-created issue may not be listed yet.
  for (const issue of await botIssues(client, repo, 'pipeline:digest')) {
    if (issue.number !== created.number) {
      await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
    }
  }
  console.log(body);
}

export async function main() {
  const [command, ...args] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  const client = tokenClient(process.env.GITHUB_TOKEN);
  const config = loadConfig();
  const commands = {
    'post-merge': () => postMerge(client, repo, config, args),
    'issue-event': () =>
      issueEvent(client, repo, config, process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))),
    audit: () => audit(client, repo, config),
    digest: () => digest(client, repo, config),
  };
  if (!commands[command]) throw new Error(`Unknown command: ${command}`);
  await commands[command]();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
