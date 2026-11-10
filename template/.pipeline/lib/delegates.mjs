// Automatic delegate suspension, and the check that a merged PR's gate result
// came from the real gate. Both run after merges, from post-merge and audit.
import { parseVerdict } from './contract.mjs';
import { claimedRevert } from './revert.mjs';

const after = (time, since) => !since || time > since;

// Labels the bot applies as records. A label can be removed, but the bot's
// `labeled` event can't be deleted, so the event is the record.
export const DELEGATE_APPROVED_LABEL = 'pipeline:delegate-approved';
export const DELEGATE_REARMED_LABEL = 'pipeline:delegate-rearmed';

const BOT = 'github-actions[bot]';
export const botLabelled = (events, label) =>
  (events ?? []).some((event) => event.event === 'labeled' && event.label?.name === label && event.actor?.login === BOT);

const RED_SHA_RE = /<!--\s*pipeline:main-red\s+sha=([0-9a-f]{7,40})\s*-->/;

export const renderRedMarker = (sha) => `<!-- pipeline:main-red sha=${sha} -->`;

// The commit a red-main issue was opened for: the body marker, or for older
// issues the short sha in the title.
export function redIssueSha(issue) {
  return RED_SHA_RE.exec(issue.body ?? '')?.[1] ?? /^Main is red at ([0-9a-f]{7,40})\b/.exec(issue.title ?? '')?.[1] ?? null;
}

const sameCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

// Shaped like evaluateBreaker. Of the last `breaker.window` ordinary merges since
// the last lift, how many a delegate approved went bad: reverted, or main went red
// at their merge commit. Each PR counts once. `delegateApproved` holds the PRs the
// bot labelled at merge, from what the gate relied on then, so nothing a delegate
// edits or deletes afterwards changes the count.
export function evaluateSuspension({ merges, delegateApproved, redIssues, config, since = null }) {
  const window = config.breaker?.window ?? 20;
  const limit = config.breaker?.delegateMaxFailures ?? 2;

  const merged = merges
    .filter((pr) => pr.merged_at && after(pr.merged_at, since))
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
  const revertedShas = merged.map((pr) => claimedRevert(pr.body)).filter(Boolean);
  const isRevert = (pr) => claimedRevert(pr.body) !== null;
  const tierOf = (pr) => parseVerdict(pr.body).verdict?.tier ?? 1;
  const counted = merged.filter((pr) => !isRevert(pr) && tierOf(pr) > 0).slice(0, window);

  const approved = counted.filter((pr) => delegateApproved.has(pr.number));
  const bad = approved
    .map((pr) => {
      const reverted = revertedShas.some((sha) => sameCommit(sha, pr.merge_commit_sha));
      const red = redIssues.filter((issue) => sameCommit(redIssueSha(issue), pr.merge_commit_sha)).map((issue) => issue.number);
      return { number: pr.number, reverted, red };
    })
    .filter((entry) => entry.reverted || entry.red.length > 0);

  return {
    suspend: bad.length >= limit,
    failures: bad.length,
    limit,
    window: counted.length,
    approved: approved.map((pr) => pr.number),
    bad,
  };
}

const GATE_EVENTS = new Set(['pull_request_target', 'issue_comment', 'workflow_run']);
// The pipeline's own workflows that re-publish the gate, and the events that run
// their default-branch copy.
const REPUBLISHERS = new Map([
  ['.github/workflows/post-merge.yml', new Set(['push'])],
  ['.github/workflows/audit.yml', new Set(['schedule', 'workflow_dispatch'])],
  ['.github/workflows/decisions.yml', new Set(['issue_comment', 'issues'])],
]);
const SLACK_MS = 60 * 1000;

// Whether a pipeline/gate check run came from the pipeline itself. The gate stamps
// each check with its workflow run's id, and a re-publish stamps `republish:<id>`.
// A delegate's token can push a workflow, and any workflow can write a check by
// that name, so this looks the run up: gate.yml from an event that runs the
// default branch's copy, or a re-publishing pipeline workflow on the default
// branch, in this repo, running when the check was written. It catches a naive
// forgery after the fact. It can't stop one written to pass it.
export function gateRunProblems(check, run, repo, defaultBranch = 'main') {
  const problems = [];
  if (check.app?.slug !== 'github-actions') problems.push(`it was written by ${check.app?.slug ?? 'an unknown app'}`);
  const stamp = /^(republish:)?(\d+)$/.exec(check.external_id ?? '');
  if (!stamp) problems.push('it carries no gate run id');
  if (!run) return [...problems, 'its workflow run could not be found'];
  const path = run.path?.replace(/@.*$/, '') ?? '';
  if (stamp?.[1]) {
    const events = REPUBLISHERS.get(path);
    if (!events) problems.push(`a re-publish came from ${path || 'an unknown workflow'}`);
    else if (!events.has(run.event)) problems.push(`a re-publish came from a ${run.event} run`);
    if (run.head_branch !== defaultBranch) problems.push(`a re-publish ran on ${run.head_branch}, not ${defaultBranch}`);
  } else {
    if (path !== '.github/workflows/gate.yml') problems.push(`it came from ${path || 'an unknown workflow'}`);
    if (!GATE_EVENTS.has(run.event)) problems.push(`its run was triggered by ${run.event}, which doesn't run the default branch's gate`);
  }
  if (run.repository?.full_name && run.repository.full_name !== repo) problems.push(`its run belongs to ${run.repository.full_name}`);
  const written = Date.parse(check.completed_at ?? check.started_at);
  const started = Date.parse(run.run_started_at ?? run.created_at);
  const ended = Date.parse(run.updated_at);
  if (!(written >= started - SLACK_MS && written <= ended + SLACK_MS)) problems.push('it was written outside its run');
  return problems;
}
