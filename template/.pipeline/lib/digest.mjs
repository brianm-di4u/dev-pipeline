// The weekly digest: the one place the admin routinely looks. It measures human
// time, with reverts and red mains as the guardrail, because if those rise, human
// time wasn't saved, only moved.
//
// With a delegate configured (or `extended`, as `pipeline metrics` asks), it also
// splits approvals and decisions by role, and measures the delegate: approval
// wait, reverts of its approvals, escalations, the admin's agreement with its
// rationale, and council rounds and reverts by worker model. Without one, the
// digest is exactly what it was.
import { authority } from './authority.mjs';
import { actorOf, approvedHash, findDecision, isApproveCommand, parseVerdict } from './contract.mjs';
import { claimedRevert } from './revert.mjs';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 3600000;
const RATIONALE_RE = /<!--\s*pipeline:rationale\b/;

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// The approval that let a merge through: an admin's at the verdict's hash if
// there is one, otherwise a delegate's. With no delegates this is the first admin
// approval, as before.
export function mergeApproval(comments, auth, hash) {
  const atHash = comments.filter((comment) => isApproveCommand(comment) && hash.startsWith(approvedHash(comment)));
  const admin = atHash.find((comment) => actorOf(comment, auth) === 'admin');
  if (admin) return { comment: admin, role: 'admin' };
  const delegate = atHash.find((comment) => actorOf(comment, auth) === 'delegate');
  return delegate ? { comment: delegate, role: 'delegate' } : null;
}

// Hours from the gate first asking for approval to the approval. An approval made
// before the first block on the merged head (a rebase moves the head) counts as 0.
// `firstBlocks` maps a PR to its first block's time, to null when its merged head
// was never blocked, or to READ_FAILED. A PR never blocked has no wait to measure,
// so it is skipped, and a failed read is counted apart rather than guessed at.
export const READ_FAILED = Symbol('read failed');

export function approvalWaits(approvals, firstBlocks) {
  const waits = [];
  for (const { pr, at, role } of approvals) {
    const block = firstBlocks.get(pr);
    if (block === READ_FAILED) {
      waits.push({ pr, role, readFailed: true });
      continue;
    }
    if (!block) continue;
    const hours = (Date.parse(at) - Date.parse(block)) / HOUR;
    waits.push(hours < 0 ? { pr, role, hours: 0, beforeBlock: true } : { pr, role, hours, beforeBlock: false });
  }
  return waits;
}

// A worker model name comes from an editable PR body, so it is checked before it
// reaches a bot issue.
const MODEL_NAME = /^[A-Za-z0-9._:\[\]-]{1,100}$/;

const stats = (values) => ({ median: percentile(values, 50), p95: percentile(values, 95) });

export function summarize({ merged, commentsByPr, decisions, config, firstBlocks = new Map(), reactions = null, escalations = null }) {
  const auth = authority(config);
  const delegated = auth.delegates.length > 0;
  const byTier = { 0: 0, 1: 0, 2: 0, revert: 0 };
  const rounds = [];
  const dispositions = {};
  const sizes = [];
  const humanTouches = [];
  const approvals = [];
  const reverted = [];
  const revertedShas = merged.map((pr) => claimedRevert(pr.body)).filter(Boolean);
  const wasReverted = (pr) =>
    revertedShas.some((sha) => pr.merge_commit_sha && (pr.merge_commit_sha.startsWith(sha) || sha.startsWith(pr.merge_commit_sha)));
  const byWorker = new Map();
  const delegateReverted = [];

  for (const pr of merged) {
    const claimed = claimedRevert(pr.body);
    if (claimed) {
      byTier.revert += 1;
      reverted.push(pr.number);
      continue;
    }
    const { verdict } = parseVerdict(pr.body);
    byTier[verdict?.tier ?? 1] += 1;
    if (verdict) {
      rounds.push(verdict.rounds);
      if (verdict.diff?.final !== undefined) sizes.push(verdict.diff.final);
      for (const finding of verdict.findings ?? []) {
        dispositions[finding.disposition] = (dispositions[finding.disposition] ?? 0) + 1;
      }
      const model = verdict.worker?.model;
      if (typeof model === 'string' && MODEL_NAME.test(model)) {
        if (!byWorker.has(model)) byWorker.set(model, { merged: 0, rounds: [], reverted: 0 });
        const entry = byWorker.get(model);
        entry.merged += 1;
        entry.rounds.push(verdict.rounds);
        if (wasReverted(pr)) entry.reverted += 1;
      }
    }
    const comments = commentsByPr.get(pr.number) ?? [];
    humanTouches.push(comments.filter((c) => config.admins.includes(c.user?.login) && !c.body?.includes('🤖')).length);
    if (verdict) {
      const approval = mergeApproval(comments, auth, verdict.changeHash);
      if (approval) {
        approvals.push({
          pr: pr.number,
          by: approval.comment.user.login,
          at: approval.comment.created_at,
          ...(delegated ? { role: approval.role } : {}),
        });
        if (approval.role === 'delegate' && wasReverted(pr)) delegateReverted.push(pr.number);
      }
    }
  }

  const waits = decisions.filter((d) => d.waitHours !== null).map((d) => d.waitHours);
  const summary = {
    merged: merged.length,
    byTier,
    humanTouches: { median: percentile(humanTouches, 50), p95: percentile(humanTouches, 95) },
    rounds: {
      median: percentile(rounds, 50),
      p95: percentile(rounds, 95),
      fiveOrMore: rounds.filter((r) => r >= 5).length,
    },
    size: { median: percentile(sizes, 50), p95: percentile(sizes, 95) },
    dispositions,
    approvals,
    reverted,
    decisionWait: { median: percentile(waits, 50), open: decisions.filter((d) => d.open).length },
  };
  if (!delegated && reactions === null && escalations === null && firstBlocks.size === 0) return summary;

  const count = (list, role) => list.filter((item) => (item.role ?? 'admin') === role).length;
  const all = approvalWaits(
    approvals.map((a) => ({ ...a, role: a.role ?? 'admin' })),
    firstBlocks,
  );
  const waited = all.filter((w) => !w.readFailed);
  return {
    ...summary,
    roles: {
      approvals: { admin: count(approvals, 'admin'), delegate: count(approvals, 'delegate') },
      decisions: { admin: decisions.filter((d) => d.decidedBy === 'admin').length, delegate: decisions.filter((d) => d.decidedBy === 'delegate').length },
    },
    approvalWait: {
      ...stats(waited.filter((w) => !w.beforeBlock).map((w) => w.hours)),
      admin: stats(waited.filter((w) => w.role === 'admin' && !w.beforeBlock).map((w) => w.hours)),
      delegate: stats(waited.filter((w) => w.role === 'delegate' && !w.beforeBlock).map((w) => w.hours)),
      beforeFirstBlock: waited.filter((w) => w.beforeBlock).length,
      readFailures: all.filter((w) => w.readFailed).length,
    },
    delegateReverted,
    escalations,
    agreement: reactions,
    byWorker: [...byWorker.entries()].map(([model, entry]) => ({ model, merged: entry.merged, rounds: stats(entry.rounds), reverted: entry.reverted })),
  };
}

// The admins' 👍 and 👎 on delegates' rationale comments.
export function tallyReactions(rationales, reactionsById, admins) {
  let up = 0;
  let down = 0;
  for (const comment of rationales) {
    for (const reaction of reactionsById.get(comment.id) ?? []) {
      if (!admins.includes(reaction.user?.login)) continue;
      if (reaction.content === '+1') up += 1;
      if (reaction.content === '-1') down += 1;
    }
  }
  return { rationales: rationales.length, up, down, rate: up + down > 0 ? up / (up + down) : null };
}

async function firstBlock(client, repo, sha) {
  let runs;
  try {
    runs = await client.list(`/repos/${repo}/commits/${sha}/check-runs?check_name=pipeline%2Fgate&filter=all&per_page=100`);
  } catch {
    return READ_FAILED;
  }
  const blocks = runs
    .filter((run) => run.name === 'pipeline/gate' && run.conclusion === 'action_required' && run.app?.slug === 'github-actions')
    .map((run) => run.completed_at ?? run.started_at)
    .filter(Boolean)
    .sort();
  return blocks[0] ?? null;
}

export async function buildDigest({ client, repo, now, config, botIssues, since: from = null, extended = false }) {
  const since = from ?? new Date(now.getTime() - 7 * DAY).toISOString();
  const auth = authority(config);
  const wide = extended || auth.delegates.length > 0;
  const pulls = await client.list(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`);
  const merged = pulls.filter((pr) => pr.merged_at && pr.merged_at >= since);

  const commentsByPr = new Map();
  for (const pr of merged) {
    commentsByPr.set(pr.number, await client.list(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`));
  }

  const decisionIssues = await client.list(`/repos/${repo}/issues?state=all&labels=decision-needed&since=${since}&per_page=100`);
  const decisions = decisionIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    open: issue.state === 'open',
    waitHours: issue.closed_at ? (new Date(issue.closed_at) - new Date(issue.created_at)) / 3600000 : null,
  }));

  const open = async (label) => (await botIssues(client, repo, label)).map((issue) => issue.number);
  const state = {
    breaker: await open('pipeline:breaker'),
    mainRed: await open('pipeline:main-red'),
    audit: await open('pipeline:audit'),
  };
  // Downloads are a nicety. A failed read shouldn't cost the admin the whole digest.
  const releases = await client.list(`/repos/${repo}/releases?per_page=10`).catch(() => []);
  if (!wide) {
    return { since, summary: summarize({ merged, commentsByPr, decisions, config }), decisions, state, downloads: releaseDownloads(releases) };
  }

  // The delegate measures. Each extra read is skipped on failure, not fatal.
  state.suspended = await open('pipeline:delegate-suspended').catch(() => []);
  const rationales = [];
  for (const [index, issue] of decisionIssues.entries()) {
    const comments = await client.list(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`).catch(() => []);
    const events = await client.list(`/repos/${repo}/issues/${issue.number}/events?per_page=100`).catch(() => undefined);
    const ctx = { ignoreSuspension: true, issueAuthor: issue.user?.login ?? null, events };
    decisions[index].decidedBy = findDecision(comments, auth, ctx)?.role ?? null;
    rationales.push(...comments.filter((c) => actorOf(c, auth) === 'delegate' && RATIONALE_RE.test(c.body ?? '')));
  }
  for (const comments of commentsByPr.values()) {
    rationales.push(...comments.filter((c) => actorOf(c, auth) === 'delegate' && RATIONALE_RE.test(c.body ?? '')));
  }
  const reactionsById = new Map();
  for (const comment of rationales) {
    reactionsById.set(comment.id, await client.list(`/repos/${repo}/issues/comments/${comment.id}/reactions?per_page=100`).catch(() => []));
  }

  const firstBlocks = new Map();
  for (const pr of merged) {
    if (pr.head?.sha) {
      firstBlocks.set(pr.number, await firstBlock(client, repo, pr.head.sha));
    }
  }

  const escalationIssues = await client.list(`/repos/${repo}/issues?state=all&labels=admin-needed&since=${since}&per_page=100`).catch(() => []);
  const raised = escalationIssues.filter((issue) => !issue.pull_request && issue.created_at >= since);
  const answered = raised.filter((issue) => issue.closed_at);
  const escalations = {
    opened: raised.length,
    answered: answered.length,
    answerHours: percentile(answered.map((issue) => (Date.parse(issue.closed_at) - Date.parse(issue.created_at)) / HOUR), 50),
    open: raised.filter((issue) => issue.state === 'open').map((issue) => issue.number),
  };

  const summary = summarize({
    merged,
    commentsByPr,
    decisions,
    config,
    firstBlocks,
    escalations,
    reactions: tallyReactions(rationales, reactionsById, config.admins),
  });
  return { since, summary, decisions, state, downloads: releaseDownloads(releases), extended: true };
}

// Total downloads per published release, with the most-fetched asset of each.
export function releaseDownloads(releases, limit = 3) {
  return releases
    .filter((release) => !release.draft)
    .slice(0, limit)
    .map((release) => {
      const assets = release.assets ?? [];
      const top = assets.reduce((best, asset) => (asset.download_count > (best?.download_count ?? -1) ? asset : best), null);
      return {
        tag: release.tag_name,
        total: assets.reduce((sum, asset) => sum + asset.download_count, 0),
        top: top?.name ?? null,
      };
    });
}

const value = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 10) / 10}${suffix}`);

function delegateSection(s) {
  const lines = ['', '## Delegates', '', '| Measure | Value |', '|---|---|'];
  const wait = s.approvalWait;
  lines.push(
    `| Approvals | admin ${s.roles.approvals.admin}, delegate ${s.roles.approvals.delegate} |`,
    `| Approval wait | median ${value(wait.median, ' h')}, p95 ${value(wait.p95, ' h')} (admin ${value(wait.admin.median, ' h')}, delegate ${value(wait.delegate.median, ' h')}); ${wait.beforeFirstBlock} approved before the first block${wait.readFailures ? `, ${wait.readFailures} not read` : ''} |`,
    `| Decisions | admin ${s.roles.decisions.admin}, delegate ${s.roles.decisions.delegate} |`,
    `| Delegate-approved merges reverted | ${s.delegateReverted.length ? s.delegateReverted.map((n) => `#${n}`).join(', ') : 'none'} |`,
  );
  if (s.escalations) {
    lines.push(
      `| Escalations (admin-needed) | ${s.escalations.opened} opened, ${s.escalations.answered} answered, median answer ${value(s.escalations.answerHours, ' h')} |`,
    );
  }
  if (s.agreement) {
    const rate = s.agreement.rate === null ? 'no reactions yet' : `${Math.round(s.agreement.rate * 100)}% agree`;
    lines.push(`| Your reactions to rationale | 👍 ${s.agreement.up}, 👎 ${s.agreement.down} on ${s.agreement.rationales} rationales (${rate}) |`);
  }
  const models = s.byWorker ?? [];
  if (models.length > 0) {
    lines.push('', '## By worker model', '', '| Model | Merged | Council rounds | Reverted |', '|---|---|---|---|');
    lines.push(...models.map((e) => `| ${e.model} | ${e.merged} | median ${value(e.rounds.median)}, p95 ${value(e.rounds.p95)} | ${e.reverted} |`));
  }
  return lines;
}

export function renderDigest({ since, summary: s, decisions, state, downloads = [], extended = false }) {
  const wide = extended && s.roles;
  const suspended = wide ? (state.suspended ?? []) : [];
  const lines = [
    `Since ${since.slice(0, 10)}.`,
    '',
    state.breaker.length || state.mainRed.length || state.audit.length || suspended.length ? '## Needs attention' : '## Status: all clear',
  ];
  if (state.breaker.length) lines.push(`- Circuit breaker tripped: ${state.breaker.map((n) => `#${n}`).join(', ')}`);
  if (state.mainRed.length) lines.push(`- Main is red: ${state.mainRed.map((n) => `#${n}`).join(', ')}`);
  if (state.audit.length) lines.push(`- Protection changed: ${state.audit.map((n) => `#${n}`).join(', ')}`);
  if (suspended.length) lines.push(`- Delegates suspended: ${suspended.map((n) => `#${n}`).join(', ')}`);

  const open = decisions.filter((d) => d.open);
  lines.push('', '## Decisions waiting on you', '');
  lines.push(...(open.length ? open.map((d) => `- #${d.number} ${d.title}`) : ['None.']));

  lines.push(
    '',
    '## This week',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Merged | ${s.merged} (T0 ${s.byTier[0]}, T1 ${s.byTier[1]}, T2 ${s.byTier[2]}, reverts ${s.byTier.revert}) |`,
    `| Human comments per PR | median ${value(s.humanTouches.median)}, p95 ${value(s.humanTouches.p95)} |`,
    `| Decision wait | median ${value(s.decisionWait.median, ' h')} |`,
    `| Council rounds to pass | median ${value(s.rounds.median)}, p95 ${value(s.rounds.p95)} |`,
    `| PRs at 5+ rounds | ${s.rounds.fiveOrMore} |`,
    `| PR size in lines | median ${value(s.size.median)}, p95 ${value(s.size.p95)} |`,
    `| Reverts | ${s.reverted.length} |`,
  );
  if (wide) lines.push(...delegateSection(s));
  lines.push('', '## How authors answered findings', '');
  const entries = Object.entries(s.dispositions);
  lines.push(...(entries.length ? entries.map(([k, v]) => `- ${k}: ${v}`) : ['No findings this week.']));

  if (downloads.length > 0) {
    lines.push('', '## Release downloads', '', '| Release | Downloads | Most fetched |', '|---|---|---|');
    lines.push(...downloads.map((d) => `| ${d.tag} | ${d.total} | ${d.top ?? 'n/a'} |`));
  }

  lines.push('', '## Every approval', '', 'If you did not make one of these, investigate it.', '');
  lines.push(
    ...(s.approvals.length ? s.approvals.map((a) => `- #${a.pr} by ${a.by}${a.role === 'delegate' ? ' (delegate)' : ''} at ${a.at}`) : ['None.']),
  );
  return lines.join('\n');
}
