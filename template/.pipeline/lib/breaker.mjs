// The circuit breaker. Reverts depend on an agent choosing to revert, so a red main
// also counts: that signal doesn't depend on anyone's judgment. Only T1 and T2
// merges count, so a run of docs merges can't dilute the window.
import { parseVerdict } from './contract.mjs';
import { claimedRevert } from './revert.mjs';

const after = (time, since) => !since || time > since;

export function evaluateBreaker({ merges, redIssues, config, since = null }) {
  const window = config.breaker?.window ?? 20;
  const limit = config.breaker?.maxFailures ?? 3;

  const merged = merges
    .filter((pr) => pr.merged_at && after(pr.merged_at, since))
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));

  const revertedShas = merged.map((pr) => claimedRevert(pr.body)).filter(Boolean);
  const isRevert = (pr) => claimedRevert(pr.body) !== null;
  const tierOf = (pr) => parseVerdict(pr.body).verdict?.tier ?? 1;

  const counted = merged.filter((pr) => !isRevert(pr) && tierOf(pr) > 0).slice(0, window);
  const oldest = counted.at(-1)?.merged_at ?? since;

  const reverted = counted.filter((pr) =>
    revertedShas.some((sha) => pr.merge_commit_sha?.startsWith(sha) || sha.startsWith(pr.merge_commit_sha ?? '\0')),
  );
  const red = redIssues.filter((issue) => after(issue.created_at, since) && (!oldest || issue.created_at >= oldest));

  const failures = reverted.length + red.length;
  return {
    tripped: failures >= limit,
    failures,
    limit,
    window: counted.length,
    reverted: reverted.map((pr) => pr.number),
    red: red.map((issue) => issue.number),
  };
}
