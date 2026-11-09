// Automatic delegate suspension, and the check that a merged PR's gate result
// came from the real gate. Both run after merges, from post-merge and audit.
import { actorOf, approvedHash, isApproveCommand, parseVerdict } from './contract.mjs';
import { claimedRevert } from './revert.mjs';

const after = (time, since) => !since || time > since;

// A delegate approved a merge when a delegate's /approve names the change the
// verdict covers and no admin approved it too. With an admin's approval as well,
// the admin owns the call.
export function delegateApproval(pr, comments, config) {
  const { verdict } = parseVerdict(pr.body);
  if (!verdict) return null;
  const approvals = (comments ?? []).filter(
    (comment) => isApproveCommand(comment) && verdict.changeHash.startsWith(approvedHash(comment)),
  );
  if (approvals.some((comment) => actorOf(comment, config) === 'admin')) return null;
  return approvals.find((comment) => actorOf(comment, config) === 'delegate')?.user.login ?? null;
}

const RED_SHA_RE = /<!--\s*pipeline:main-red\s+sha=([0-9a-f]{7,40})\s*-->/;

export const renderRedMarker = (sha) => `<!-- pipeline:main-red sha=${sha} -->`;

// The commit a red-main issue was opened for: the body marker, or for older
// issues the short sha in the title.
export function redIssueSha(issue) {
  return RED_SHA_RE.exec(issue.body ?? '')?.[1] ?? /^Main is red at ([0-9a-f]{7,40})\b/.exec(issue.title ?? '')?.[1] ?? null;
}

const sameCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

// Shaped like evaluateBreaker. Of the last `breaker.window` ordinary merges since
// the last lift, how many that a delegate approved went bad: reverted, or main
// went red at their merge commit. Each PR counts once.
export function evaluateSuspension({ merges, commentsByPr, redIssues, config, since = null }) {
  const window = config.breaker?.window ?? 20;
  const limit = config.breaker?.delegateMaxFailures ?? 2;

  const merged = merges
    .filter((pr) => pr.merged_at && after(pr.merged_at, since))
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
  const revertedShas = merged.map((pr) => claimedRevert(pr.body)).filter(Boolean);
  const isRevert = (pr) => claimedRevert(pr.body) !== null;
  const tierOf = (pr) => parseVerdict(pr.body).verdict?.tier ?? 1;
  const counted = merged.filter((pr) => !isRevert(pr) && tierOf(pr) > 0).slice(0, window);

  const approved = counted
    .map((pr) => ({ pr, login: delegateApproval(pr, commentsByPr.get(pr.number) ?? [], config) }))
    .filter((entry) => entry.login);
  const bad = approved
    .map(({ pr, login }) => {
      const reverted = revertedShas.some((sha) => sameCommit(sha, pr.merge_commit_sha));
      const red = redIssues.filter((issue) => sameCommit(redIssueSha(issue), pr.merge_commit_sha)).map((issue) => issue.number);
      return { number: pr.number, login, reverted, red };
    })
    .filter((entry) => entry.reverted || entry.red.length > 0);

  return {
    suspend: bad.length >= limit,
    failures: bad.length,
    limit,
    window: counted.length,
    approved: approved.map(({ pr }) => pr.number),
    bad,
  };
}

const GATE_EVENTS = new Set(['pull_request_target', 'issue_comment', 'workflow_run']);
const SLACK_MS = 60 * 1000;

// Whether a pipeline/gate check run came from gate.yml on the default branch.
// The gate stamps each check with its workflow run's id. A delegate's token can
// push a workflow, and any workflow can write a check by that name, so this looks
// the run up: it must be gate.yml, from an event that runs the default branch's
// copy, in this repo, and running when the check was written. It catches a naive
// forgery after the fact. It can't stop one written to pass it.
export function gateRunProblems(check, run, repo) {
  const problems = [];
  if (check.app?.slug !== 'github-actions') problems.push(`it was written by ${check.app?.slug ?? 'an unknown app'}`);
  if (!/^\d+$/.test(check.external_id ?? '')) problems.push('it carries no gate run id');
  if (!run) return [...problems, 'its workflow run could not be found'];
  if (run.path?.replace(/@.*$/, '') !== '.github/workflows/gate.yml') problems.push(`it came from ${run.path ?? 'an unknown workflow'}`);
  if (!GATE_EVENTS.has(run.event)) problems.push(`its run was triggered by ${run.event}, which doesn't run the default branch's gate`);
  if (run.repository?.full_name && run.repository.full_name !== repo) problems.push(`its run belongs to ${run.repository.full_name}`);
  const written = Date.parse(check.completed_at ?? check.started_at);
  const started = Date.parse(run.run_started_at ?? run.created_at);
  const ended = Date.parse(run.updated_at);
  if (!(written >= started - SLACK_MS && written <= ended + SLACK_MS)) problems.push('it was written outside its run');
  return problems;
}
