// Repository state that lives in bot-authored issues: a red main, the circuit
// breaker, and delegate suspensions. One reader for the gate, monitor, and
// autopilot, so they can't disagree.
import { authority } from './authority.mjs';
import { hasRearm, rearmBy, rearmGrant } from './contract.mjs';

export const BOT = 'github-actions[bot]';
const encodedBot = encodeURIComponent(BOT);

// The title each kind of state issue opens with.
export const STATE_TITLES = {
  'pipeline:main-red': 'Main is red at ',
  'pipeline:breaker': 'Circuit breaker tripped',
  'pipeline:delegate-suspended': 'Delegates suspended',
};

// Every kind of issue the bot opens, so an issue that looks like none of them
// stands out as one whose label and title were changed.
const KNOWN_KINDS = [
  ...Object.entries(STATE_TITLES).map(([label, title]) => ({ label, titles: [title] })),
  { label: 'pipeline:audit', titles: ['Branch protection changed', 'pipeline/gate on #'] },
  { label: 'pipeline:digest', titles: ['Weekly digest'] },
];

const hasLabel = (issue, label) => (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === label);
const looksLike = (issue, label, titles) => hasLabel(issue, label) || titles.some((title) => issue.title?.startsWith(title));

export const botLabelledWith = (events, label) =>
  (events ?? []).some((event) => event.event === 'labeled' && event.label?.name === label && event.actor?.login === BOT);

async function eventsOf(client, repo, number, cache) {
  if (!cache.has(number)) cache.set(number, await client.list(`/repos/${repo}/issues/${number}/events?per_page=100`));
  return cache.get(number);
}

// Bot issues of one kind. Without a delegate this is today's label query.
//
// With one, a write collaborator could edit a label or a title, so what an issue
// is comes from its creator, the bot, and the bot's own `labeled` event, which
// nobody can delete. Open bot issues, issues that look like this kind, and issues
// that look like no kind at all are checked against those events. A closed issue
// that looks like another kind is taken at its word, which keeps the reads few.
export async function stateIssues(client, repo, config, label, state = 'open', cache = new Map()) {
  if (authority(config).delegates.length === 0) {
    return client.list(`/repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&creator=${encodedBot}&per_page=100`);
  }
  const all = await client.list(`/repos/${repo}/issues?state=${state}&creator=${encodedBot}&per_page=100`);
  const found = [];
  for (const issue of all) {
    if (issue.pull_request || issue.user?.login !== BOT) continue;
    const thisKind = looksLike(issue, label, [STATE_TITLES[label]].filter(Boolean));
    const anyKind = KNOWN_KINDS.some((kind) => looksLike(issue, kind.label, kind.titles));
    if (issue.state !== 'open' && !thisKind && anyKind) continue;
    if (botLabelledWith(await eventsOf(client, repo, issue.number, cache), label)) found.push(issue);
  }
  return found;
}

const comments = (client, repo, number) => client.list(`/repos/${repo}/issues/${number}/comments?per_page=100`);

// Each bot-opened suspension is a window from when it opened until an admin's
// /rearm on it, if the issue is closed. A delegate command posted inside any
// window never counts, even after the lift. Only an admin lifts a suspension.
export async function readSuspension(client, repo, config, cache = new Map()) {
  const issues = (await stateIssues(client, repo, config, 'pipeline:delegate-suspended', 'all', cache)).sort((a, b) => a.number - b.number);
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
  const cache = new Map();

  const redIssues = await stateIssues(client, repo, config, 'pipeline:main-red', 'open', cache);
  const citesMainRed = redIssues.some((issue) =>
    new RegExp(`^Fixes-main-red:\\s*#${issue.number}\\s*$`, 'im').test(body ?? ''),
  );

  const suspension = delegated ? await readSuspension(client, repo, config, cache) : null;

  const breakers = (await stateIssues(client, repo, config, 'pipeline:breaker', 'all', cache)).sort((a, b) => b.number - a.number);
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
      // within its one-time grant and outside any suspension window, posted /rearm.
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

// Whether a bot issue is the kind `label` says, from the bot's own labelled event.
export async function isStateIssue(client, repo, issue, label) {
  if (issue?.user?.login !== BOT) return false;
  return botLabelledWith(await client.list(`/repos/${repo}/issues/${issue.number}/events?per_page=100`), label);
}
