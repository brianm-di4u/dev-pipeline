// Frozen copy of gate.mjs repoState as it was before delegates existed. Tests
// compare lib/state.mjs against it to prove that, with no `delegates` key,
// nothing changed. Never edit it.
import { hasRearm } from './contract.mjs';

const encodedBot = encodeURIComponent('github-actions[bot]');

export async function repoState(client, repo, config, body) {
  const redIssues = await client.list(
    `/repos/${repo}/issues?state=open&labels=pipeline:main-red&creator=${encodedBot}&per_page=20`,
  );
  const citesMainRed = redIssues.some((issue) =>
    new RegExp(`^Fixes-main-red:\\s*#${issue.number}\\s*$`, 'im').test(body ?? ''),
  );

  const breakerIssues = await client.list(
    `/repos/${repo}/issues?state=all&labels=pipeline:breaker&creator=${encodedBot}&per_page=20`,
  );
  let breakerTripped = false;
  const latest = breakerIssues.sort((a, b) => b.number - a.number)[0];
  if (latest) {
    if (latest.state === 'open') {
      breakerTripped = true;
    } else {
      // A closed breaker counts as re-armed only if an admin posted /rearm.
      const comments = await client.list(`/repos/${repo}/issues/${latest.number}/comments?per_page=100`);
      breakerTripped = !hasRearm(comments, config.admins);
    }
  }
  return { mainRed: redIssues.length > 0, citesMainRed, breakerTripped };
}
