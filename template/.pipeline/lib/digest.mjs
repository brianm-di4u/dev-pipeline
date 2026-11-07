// The weekly digest: the one place the admin routinely looks. It measures human
// time, with reverts and red mains as the guardrail, because if those rise, human
// time wasn't saved, only moved.
import { findApproval, parseVerdict } from './contract.mjs';
import { claimedRevert } from './revert.mjs';

const DAY = 24 * 60 * 60 * 1000;

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summarize({ merged, commentsByPr, decisions, config }) {
  const byTier = { 0: 0, 1: 0, 2: 0, revert: 0 };
  const rounds = [];
  const dispositions = {};
  const sizes = [];
  const humanTouches = [];
  const approvals = [];
  const reverted = [];

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
    }
    const comments = commentsByPr.get(pr.number) ?? [];
    humanTouches.push(comments.filter((c) => config.admins.includes(c.user?.login) && !c.body?.includes('🤖')).length);
    if (verdict) {
      const approval = findApproval(comments, config.admins, verdict.changeHash);
      if (approval) approvals.push({ pr: pr.number, by: approval.user.login, at: approval.created_at });
    }
  }

  const waits = decisions.filter((d) => d.waitHours !== null).map((d) => d.waitHours);
  return {
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
}

export async function buildDigest({ client, repo, now, config, botIssues }) {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
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
  return { since, summary: summarize({ merged, commentsByPr, decisions, config }), decisions, state };
}

const value = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 10) / 10}${suffix}`);

export function renderDigest({ since, summary: s, decisions, state }) {
  const lines = [
    `Since ${since.slice(0, 10)}.`,
    '',
    state.breaker.length || state.mainRed.length || state.audit.length ? '## Needs attention' : '## Status: all clear',
  ];
  if (state.breaker.length) lines.push(`- Circuit breaker tripped: ${state.breaker.map((n) => `#${n}`).join(', ')}`);
  if (state.mainRed.length) lines.push(`- Main is red: ${state.mainRed.map((n) => `#${n}`).join(', ')}`);
  if (state.audit.length) lines.push(`- Protection changed: ${state.audit.map((n) => `#${n}`).join(', ')}`);

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
    '',
    '## How authors answered findings',
    '',
  );
  const entries = Object.entries(s.dispositions);
  lines.push(...(entries.length ? entries.map(([k, v]) => `- ${k}: ${v}`) : ['No findings this week.']));

  lines.push('', '## Every approval', '', 'If you did not make one of these, investigate it.', '');
  lines.push(...(s.approvals.length ? s.approvals.map((a) => `- #${a.pr} by ${a.by} at ${a.at}`) : ['None.']));
  return lines.join('\n');
}
