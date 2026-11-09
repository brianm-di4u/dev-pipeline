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
import { delegateMayRearm, evaluateBreaker } from './lib/breaker.mjs';
import { authority } from './lib/authority.mjs';
import { loadConfig } from './lib/config.mjs';
import {
  REARM_OK_MARKER,
  actorOf,
  decisionProblems,
  findDecision,
  hasRearm,
  isApproveCommand,
  isDecideCommand,
  isRearmCommand,
  parseDecisionClass,
  parseVerdict,
  rearmBy,
  rearmProblems,
  recordedClass,
  renderClassMarker,
} from './lib/contract.mjs';
import { evaluateSuspension, gateRunProblems, renderRedMarker } from './lib/delegates.mjs';
import { buildDigest, renderDigest } from './lib/digest.mjs';
import { tokenClient } from './lib/github.mjs';
import { STATE_TITLES, readSuspension, stateIssues } from './lib/state.mjs';
import { CHECK_NAME, reevaluate } from './gate.mjs';
import { claimedRevert } from './lib/revert.mjs';

const BOT = 'github-actions[bot]';
const encodedBot = encodeURIComponent(BOT);
const GITHUB_ACTIONS_APP_ID = 15368;

const LABELS = {
  'pipeline:main-red': 'b60205',
  'pipeline:breaker': 'b60205',
  'pipeline:audit': 'b60205',
  'pipeline:digest': '0e8a16',
  'pipeline:delegate-suspended': 'b60205',
  'pipeline:delegate-touched': 'd93f0b',
  'admin-needed': 'b60205',
  garden: '0e8a16',
  'complexity:high': '5319e7',
  'complexity:low': 'c5def5',
  'decision-needed': 'fbca04',
  decided: '0e8a16',
};

const PROTECTION_TITLE = 'Branch protection changed';

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

export async function checkBreaker(client, repo, config, suspension = {}) {
  const breakerIssues = (await stateIssues(client, repo, config, 'pipeline:breaker', 'all')).sort((a, b) => b.number - a.number);
  const latest = breakerIssues[0];
  if (latest?.state === 'open') return { tripped: true, alreadyOpen: true };

  const merges = (await client.list(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`)).filter(
    (pr) => pr.merged_at,
  );
  const redIssues = await stateIssues(client, repo, config, 'pipeline:main-red', 'all');
  const result = evaluateBreaker({ merges, redIssues, config, since: latest?.closed_at ?? null });

  if (result.tripped) {
    const created = await openIssue(
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
    await offerDelegateRearm(client, repo, config, created, latest, result, suspension);
  }
  return result;
}

// Issue bodies are editable by collaborators, so the grant lives in a bot
// comment, which the delegate's /rearm must follow.
async function offerDelegateRearm(client, repo, config, created, previous, result, suspension) {
  const auth = authority(config);
  const rearmers = auth.delegates.filter((grant) => grant.rearm).map((grant) => grant.login);
  if (rearmers.length === 0 || !created?.number) return;
  const before = previous ? await client.list(`/repos/${repo}/issues/${previous.number}/comments?per_page=100`) : [];
  if (!delegateMayRearm({ result, previousRearm: rearmBy(before, auth, suspension), config })) return;
  await client.post(`/repos/${repo}/issues/${created.number}/comments`, {
    body: `A delegate (${rearmers.join(', ')}) may re-arm this trip once, after posting the root cause here. A second trip within the window needs an admin.\n\n${REARM_OK_MARKER}`,
  });
}

export async function postMerge(client, repo, config, args) {
  const result = args[args.indexOf('--result') + 1];
  const sha = process.env.GITHUB_SHA;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const delegated = authority(config).delegates.length > 0;
  const open = await stateIssues(client, repo, config, 'pipeline:main-red');

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
        // The full sha ties this to the merge that broke main, for delegate suspension.
        ...(delegated ? ['', renderRedMarker(sha)] : []),
      ].join('\n'),
    );
  }
  const suspension = delegated ? await readSuspension(client, repo, config) : {};
  const breaker = await checkBreaker(client, repo, config, suspension);
  // Only a push to main is a merge to check. smoke.mjs reuses this on a schedule.
  const merged = delegated && process.env.GITHUB_EVENT_NAME === 'push';
  const gate = merged ? await checkGateProvenance(client, repo, config, sha) : undefined;
  const delegates = delegated ? await checkDelegates(client, repo, config) : undefined;
  console.log(JSON.stringify({ result, breaker, ...(delegated ? { gate, delegates } : {}) }));
}

// Delegate state needs a full checkout to re-run the gate. See post-merge.yml.
export async function suspendDelegates(client, repo, config, reason, lines, republish = reevaluate) {
  const created = await openIssue(
    client,
    repo,
    'pipeline:delegate-suspended',
    `${STATE_TITLES['pipeline:delegate-suspended']}: ${reason}`,
    [
      `${mentions(config)} delegate commands are suspended: ${reason}.`,
      '',
      ...lines,
      '',
      "No delegate's approve, decide or rearm counts until you comment `/rearm` on this issue. Commands a delegate posts while suspended never count, even after that.",
    ].join('\n'),
  );
  // Nothing re-runs the gate when an issue opens, and a check already green
  // could merge on a now-void approval. Re-publish every PR a delegate approved.
  const auth = authority(config);
  const held = [];
  for (const pr of await client.list(`/repos/${repo}/pulls?state=open&per_page=100`)) {
    const comments = await client.list(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
    if (comments.some((comment) => actorOf(comment, auth) === 'delegate' && isApproveCommand(comment))) held.push(pr.number);
  }
  const republished = held.length > 0 ? await republish(client, repo, held) : [];
  return { issue: created?.number ?? null, republished };
}

// Two delegate-approved merges that went bad within the breaker window suspend
// every delegate until an admin lifts it.
export async function checkDelegates(client, repo, config, republish = reevaluate) {
  if (authority(config).delegates.length === 0) return null;
  const suspension = await readSuspension(client, repo, config);
  if (suspension.suspended) return { suspend: false, alreadySuspended: true };
  const since = suspension.suspensions.map((window) => window.to).filter(Boolean).sort().at(-1) ?? null;

  const merges = (await client.list(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`)).filter(
    (pr) => pr.merged_at && (!since || pr.merged_at > since),
  );
  // Only merges that can count need their comments.
  const window = config.breaker?.window ?? 20;
  const candidates = merges
    .filter((pr) => !claimedRevert(pr.body) && (parseVerdict(pr.body).verdict?.tier ?? 1) > 0)
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))
    .slice(0, window);
  const commentsByPr = new Map();
  for (const pr of candidates) {
    commentsByPr.set(pr.number, await client.list(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`));
  }
  const redIssues = await stateIssues(client, repo, config, 'pipeline:main-red', 'all');
  const result = evaluateSuspension({ merges, commentsByPr, redIssues, config, since });
  if (result.suspend) {
    const lines = result.bad.map(
      (bad) => `- #${bad.number}, approved by ${bad.login}: ${[bad.reverted ? 'reverted' : null, ...bad.red.map((n) => `main went red (#${n})`)].filter(Boolean).join(', ')}`,
    );
    result.suspension = await suspendDelegates(
      client,
      repo,
      config,
      `${result.failures} delegate-approved merges went bad`,
      [`In the last ${result.window} ordinary merges, against a limit of ${result.limit}:`, '', ...lines],
      republish,
    );
  }
  return result;
}

// Did the merged PR's gate check come from gate.yml on the default branch? A
// delegate's token has the workflow scope, and a pushed workflow can write a check
// named pipeline/gate. If not, open an audit issue and suspend delegates.
export async function checkGateProvenance(client, repo, config, sha, republish = reevaluate) {
  if (authority(config).delegates.length === 0 || !sha) return null;
  // The gate that judged this merge ran on the parent's policy. Before that policy
  // had a delegate, the gate stamped nothing, so there is nothing to check.
  const commit = await client.get(`/repos/${repo}/commits/${sha}`);
  const parent = commit?.parents?.[0]?.sha;
  const parentConfig = parent ? await readConfigAt(client, repo, parent) : null;
  if (parentConfig && authority(parentConfig).delegates.length === 0) return { skipped: 'the gate for this merge predates delegates' };

  const prs = await client.list(`/repos/${repo}/commits/${sha}/pulls?per_page=100`);
  const pr = prs.find((candidate) => candidate.merge_commit_sha === sha) ?? prs.find((candidate) => candidate.merged_at);
  if (!pr) return { skipped: 'no PR merged this commit' };

  const runs = await client.list(
    `/repos/${repo}/commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
  );
  const check = runs.filter((run) => run.name === CHECK_NAME && run.status === 'completed').sort((a, b) => b.id - a.id)[0];
  let problems;
  if (!check) {
    problems = [`the merged head has no ${CHECK_NAME} check`];
  } else {
    const run = /^\d+$/.test(check.external_id ?? '')
      ? await client.get(`/repos/${repo}/actions/runs/${check.external_id}`).catch(() => null)
      : null;
    problems = gateRunProblems(check, run, repo);
  }
  if (problems.length === 0) return { ok: true, pr: pr.number };

  const title = `${CHECK_NAME} on #${pr.number} did not come from the gate`;
  if ((await botIssues(client, repo, 'pipeline:audit')).some((issue) => issue.title === title)) {
    return { ok: false, pr: pr.number, problems, alreadyReported: true };
  }
  await openIssue(client, repo, 'pipeline:audit', title, [
    `${mentions(config)} the \`${CHECK_NAME}\` check that let #${pr.number} merge doesn't look like the gate's own:`,
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'A workflow pushed with a token that has the `workflow` scope can write that check. Delegates are suspended until you look.',
  ].join('\n'));
  const already = (await readSuspension(client, repo, config)).suspended;
  const suspension = already
    ? null
    : await suspendDelegates(client, repo, config, `the ${CHECK_NAME} check on #${pr.number} may be forged`, [`See the audit issue for #${pr.number}.`], republish);
  return { ok: false, pr: pr.number, problems, suspension };
}

async function readConfigAt(client, repo, ref) {
  try {
    const file = await client.get(`/repos/${repo}/contents/pipeline.config.json?ref=${ref}`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
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
    // A delegate escalates with an issue, because labelling a PR doesn't fire this
    // workflow. The label is the admin's whole inbox, so it pings them.
    if (event.action === 'labeled' && event.label?.name === 'admin-needed' && auth.delegates.length > 0) {
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
        body: `${mentions(config)} this needs you. The issue says what's waiting and what the delegate recommends. Nothing here has a default by timeout.`,
      });
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

  // Only an admin lifts a delegate suspension.
  const isSuspension =
    auth.delegates.length > 0 &&
    issue.user?.login === BOT &&
    (labels.includes('pipeline:delegate-suspended') || issue.title?.startsWith(STATE_TITLES['pipeline:delegate-suspended']));
  if (isSuspension) {
    if (hasRearm([comment], config.admins)) {
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
        body: 'Delegates are back on. A delegate command posted while they were suspended still never counts.',
      });
      await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
    } else if (actorOf(comment, auth) === 'delegate' && isRearmCommand(comment)) {
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, { body: 'Only an admin can lift a delegate suspension.' });
    }
    return;
  }

  // With a delegate, a stripped label doesn't hide a breaker issue: its title still says what it is.
  const isBreaker =
    issue.user?.login === BOT &&
    (labels.includes('pipeline:breaker') || (auth.delegates.length > 0 && issue.title?.startsWith(STATE_TITLES['pipeline:breaker'])));
  if (isBreaker && !hasRearm([comment], config.admins) && actorOf(comment, auth) === 'delegate' && isRearmCommand(comment)) {
    const list = await client.list(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
    const problems = rearmProblems(comment, auth, list, ctx);
    if (problems.length > 0) {
      await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
        body: `The re-arm by ${comment.user.login} doesn't count: ${problems.join('; ')}.`,
      });
      return;
    }
    await client.post(`/repos/${repo}/issues/${issue.number}/comments`, {
      body: `Re-armed by delegate ${comment.user.login}. T1 auto-merge is back on, and the failure count starts over. Another trip within the window needs an admin to re-arm.`,
    });
    await client.patch(`/repos/${repo}/issues/${issue.number}`, { state: 'closed' });
    return;
  }

  if (isBreaker && hasRearm([comment], config.admins)) {
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

export async function audit(client, repo, config) {
  const info = await client.get(`/repos/${repo}`);
  const branch = await client.get(`/repos/${repo}/branches/${info.default_branch}`);
  const problems = auditProblems(branch);
  // Other audit issues, such as a forged gate check, stay open until the admin closes them.
  const open = (await botIssues(client, repo, 'pipeline:audit')).filter((issue) => issue.title === PROTECTION_TITLE);
  console.log(problems.length ? problems.join('\n') : 'Protection is intact.');
  if (problems.length > 0 && open.length === 0) {
    await openIssue(
      client,
      repo,
      'pipeline:audit',
      PROTECTION_TITLE,
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
  // A backstop, in case post-merge missed a suspension.
  if (authority(config).delegates.length > 0) console.log(JSON.stringify({ delegates: await checkDelegates(client, repo, config) }));
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
    'issue-event': async () => {
      // A delegate's command needs the suspension state. Without a delegate, nothing more is read.
      const ctx = authority(config).delegates.length > 0 ? await readSuspension(client, repo, config) : {};
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      await issueEvent(client, repo, config, process.env.GITHUB_EVENT_NAME, event, ctx);
    },
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
