// What waits on a human-level call, as plain data, for a delegate's inbox. Pure
// functions: garden.mjs gathers the inputs, using the gate's own code for PRs.
import { authority } from './authority.mjs';
import { findDecision, parseDecisionClass, parseVerdict, recordedClass } from './contract.mjs';

const DAY = 24 * 60 * 60 * 1000;

// One PR the gate holds, from the gate's own evaluation, so the inbox can't drift
// from what the gate will accept.
export function prItem(pr, result) {
  const delegate = result.delegate ?? null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? null,
    hash: result.shortHash,
    tier: result.tier,
    gate: result.conclusion ?? result.status,
    gateTitle: result.title,
    reasons: result.reasons,
    blockers: result.blockers,
    approved: result.approved,
    approvalRole: delegate?.approvalRole ?? null,
    delegateMayApprove: Boolean(delegate?.mayApprove),
    // Why each delegate couldn't approve it, and any of its approvals that didn't count.
    barriers: delegate?.barriers ?? {},
    refusals: delegate?.refusals ?? [],
  };
}

// The options a decision request names: `- **A (recommended):** ...` lines.
export function parseOptions(body) {
  const options = [];
  for (const match of (body ?? '').matchAll(/^[ \t]*[-*][ \t]+\*\*([^*\n]+?)\*\*[ \t]*:?[ \t]*(.*)$/gm)) {
    const label = match[1].replace(/:$/, '').trim();
    if (/^class$/i.test(label) || /^(context|options|what's waiting)$/i.test(label)) continue;
    const recommended = /\(recommended\)/i.test(label);
    options.push({ name: label.replace(/\s*\(recommended\)\s*/i, '').trim(), recommended, text: match[2].trim() });
  }
  return options;
}

export function decisionItem(issue, comments, config, suspension = {}) {
  const auth = authority(config);
  const recorded = recordedClass(comments);
  const cls = recorded?.class ?? null;
  const bodyClass = parseDecisionClass(issue.body);
  const deciders = cls ? auth.delegates.filter((grant) => grant.decide.includes(cls)).map((grant) => grant.login) : [];
  const decision = findDecision(comments, auth, suspension);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    class: cls,
    // The body may have changed since the bot recorded the class. The recorded
    // one rules; a mismatch is worth a second look.
    bodyClass,
    classMismatch: recorded !== null && bodyClass !== cls,
    options: parseOptions(issue.body),
    deciders,
    delegateMayDecide: deciders.length > 0 && suspension.suspended === false,
    decided: decision ? { option: decision.option, by: decision.comment.user.login, role: decision.role } : null,
  };
}

// The same council finding class across several merged PRs is a pattern worth
// fixing at the root, by AUTONOMY's ladder.
export function recurringFindings(merged, minPrs = 3) {
  const byClass = new Map();
  for (const pr of merged) {
    const classes = new Set((parseVerdict(pr.body).verdict?.findings ?? []).map((finding) => finding.class).filter(Boolean));
    for (const cls of classes) byClass.set(cls, [...(byClass.get(cls) ?? []), pr.number]);
  }
  return [...byClass.entries()]
    .filter(([, prs]) => prs.length >= minPrs)
    .map(([cls, prs]) => ({ class: cls, prs, count: prs.length }))
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}

export function stalePrs(open, now, days = 7) {
  const cutoff = now.getTime() - days * DAY;
  return open
    .filter((pr) => Date.parse(pr.updated_at) < cutoff)
    .map((pr) => ({ number: pr.number, title: pr.title, updated: pr.updated_at, draft: Boolean(pr.draft) }));
}

// `refs` are { name, date } for remote branches. A branch with an open PR, or the
// default branch, isn't stale however old it is.
export function staleBranches(refs, openHeads, defaultBranch, now, days = 14) {
  const cutoff = now.getTime() - days * DAY;
  return refs
    .filter((ref) => ref.name !== defaultBranch && !openHeads.includes(ref.name) && Date.parse(ref.date) < cutoff)
    .map((ref) => ({ branch: ref.name, lastCommit: ref.date }));
}

// Project-specific counts the gardener watches for growth, from the optional
// `garden.counts` config: [{ name, paths: [...], pattern }].
export function countMatches(texts, pattern) {
  const re = new RegExp(pattern, 'g');
  return texts.reduce((sum, text) => sum + ((text ?? '').match(re)?.length ?? 0), 0);
}
