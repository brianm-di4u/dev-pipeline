// Repository state that lives in bot-authored issues: a red main, the circuit
// breaker, and delegate suspensions. One reader for the gate, monitor, and
// autopilot, so they can't disagree.
import { authority } from './authority.mjs';
import { hasRearm, rearmBy, rearmGrant } from './contract.mjs';

export const BOT = 'github-actions[bot]';
const encodedBot = encodeURIComponent(BOT);

// The title each kind of state issue opens with. A collaborator can remove a
// label, so with a delegate configured, state issues are also found by the bot's
// authorship plus this title.
export const STATE_TITLES = {
  'pipeline:main-red': 'Main is red at ',
  'pipeline:breaker': 'Circuit breaker tripped',
  'pipeline:delegate-suspended': 'Delegates suspended',
};

const hasLabel = (issue, label) => (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === label);

// Bot issues of one kind. Without a delegate this is today's label query.
export async function stateIssues(client, repo, config, label, state = 'open') {
  if (authority(config).delegates.length === 0) {
    return client.list(`/repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&creator=${encodedBot}&per_page=100`);
  }
  const all = await client.list(`/repos/${repo}/issues?state=${state}&creator=${encodedBot}&per_page=100`);
  return all.filter(
    (issue) => !issue.pull_request && issue.user?.login === BOT && (hasLabel(issue, label) || issue.title?.startsWith(STATE_TITLES[label])),
  );
}

const comments = (client, repo, number) => client.list(`/repos/${repo}/issues/${number}/comments?per_page=100`);

// Each bot-opened suspension is a window from when it opened until an admin's
// /rearm on it, if the issue is closed. A delegate command posted inside any
// window never counts, even after the lift. Only an admin lifts a suspension.
export async function readSuspension(client, repo, config) {
  const issues = (await stateIssues(client, repo, config, 'pipeline:delegate-suspended', 'all')).sort((a, b) => a.number - b.number);
  const suspensions = [];
  for (const issue of issues) {
    let to = null;
    if (issue.state === 'closed') {
      const lift = (await comments(client, repo, issue.number)).find((c) => hasRearm([c], config.admins));
      to = lift?.created_at ?? null;
    }
    suspensions.push({ from: issue.created_at, to, issue: issue.number });
  }
  return { suspended: suspensions.some((window) => window.to === null), suspensions };
}

// `body` is a PR body, for whether it cites the red-main issue.
export async function readRepoState(client, repo, config, body = '') {
  const auth = authority(config);
  const delegated = auth.delegates.length > 0;

  const redIssues = await stateIssues(client, repo, config, 'pipeline:main-red', 'open');
  const citesMainRed = redIssues.some((issue) =>
    new RegExp(`^Fixes-main-red:\\s*#${issue.number}\\s*$`, 'im').test(body ?? ''),
  );

  const suspension = delegated ? await readSuspension(client, repo, config) : null;

  const breakers = (await stateIssues(client, repo, config, 'pipeline:breaker', 'all')).sort((a, b) => b.number - a.number);
  const latest = breakers[0];
  let breakerTripped = false;
  let delegateRearmOk = false;
  if (latest) {
    const needComments = latest.state !== 'open' || delegated;
    const list = needComments ? await comments(client, repo, latest.number) : [];
    if (latest.state === 'open') {
      breakerTripped = true;
    } else {
      // A closed breaker counts as re-armed only if an admin, or a delegate
      // within its one-time grant, posted /rearm.
      breakerTripped = !rearmBy(list, auth, suspension ?? {});
    }
    if (delegated) delegateRearmOk = latest.state === 'open' && rearmGrant(list) !== null;
  }

  const state = {
    mainRed: redIssues.length > 0,
    citesMainRed,
    breakerTripped,
    redIssue: redIssues[0]?.number ?? null,
  };
  if (delegated) Object.assign(state, suspension, { delegateRearmOk, breakerIssue: latest?.number ?? null });
  return state;
}
