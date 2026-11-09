// Autopilot's decisions as plain code: whether to keep going, and what to do next.
import { toAuthority } from './authority.mjs';

const DAY = 24 * 60 * 60 * 1000;

// Issues from outsiders never start work, whatever labels they carry. Agent-filed
// issues carry the owner's login, so they arrive labeled `triage` and need a
// verifier before they count as `ready`. A delegate whose grant has `direct` can
// start work too. `auth` is a bare admins list, a config, or an authority.
export function eligible(issue, auth) {
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  const who = toAuthority(auth);
  const login = issue.user?.login;
  return (
    !issue.pull_request &&
    issue.state === 'open' &&
    (who.isAdmin(login) || who.delegateOf(login)?.direct === true) &&
    labels.includes('ready') &&
    !labels.includes('triage') &&
    !labels.includes('blocked:decision') &&
    !labels.includes('decision-needed')
  );
}

const priority = (issue) => {
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  if (labels.includes('priority:high')) return 0;
  if (labels.includes('priority:low')) return 2;
  return 1;
};

export function pickNext(issues, auth) {
  return [...issues.filter((issue) => eligible(issue, auth))].sort(
    (a, b) => priority(a) - priority(b) || a.number - b.number,
  )[0] ?? null;
}

export function nextAction({ issues, config, mainRed, breakerTripped, merges, openOwnPrs, run, now, sourceError }) {
  // A failed read isn't a quiet day. Say so rather than reporting an empty queue.
  if (sourceError) return { action: 'stop', reason: `Could not read GitHub: ${sourceError}. This is not an empty queue.` };

  const autopilot = config.autopilot ?? {};
  if (mainRed) return { action: 'fix-main', reason: 'Main is red. Reverting or fixing it comes first.' };
  if (breakerTripped) return { action: 'stop', reason: 'The circuit breaker is tripped. The admin has to re-arm it.' };

  const failures = run?.consecutiveFailures ?? 0;
  const maxFailures = autopilot.maxConsecutiveFailures ?? 2;
  if (failures >= maxFailures) return { action: 'stop', reason: `${failures} tasks failed in a row. Something is wrong beyond any one task.` };

  // One PR at a time: strict up-to-date checks make parallel merges churn.
  if (openOwnPrs.length > 0) {
    return { action: 'finish-pr', pr: openOwnPrs[0], reason: `Finish #${openOwnPrs[0]} first.` };
  }

  const dayAgo = new Date(now.getTime() - DAY).toISOString();
  const mergedToday = merges.filter((pr) => pr.merged_at && pr.merged_at >= dayAgo).length;
  const budget = autopilot.maxPrsPerDay ?? 5;
  if (mergedToday >= budget) return { action: 'stop', reason: `Daily budget spent: ${mergedToday} of ${budget} PRs merged in the last 24 hours.` };

  const issue = pickNext(issues, config);
  if (!issue) return { action: 'stop', reason: 'The ready queue is empty.' };
  const work = { action: 'work', issue: { number: issue.number, title: issue.title }, reason: `${mergedToday} of ${budget} PRs merged today.` };
  const model = workerModel(issue, config.models, run);
  return model ? { ...work, model } : work;
}

// Which model a worker for this issue should run on, from the optional `models`
// config. A session can't switch its own model, so whoever starts the worker
// applies this. With no `models` key, there is no model to report.
export function workerModel(issue, models, run) {
  if (!models || typeof models !== 'object') return null;
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  // A task a worker already failed or parked gets the stronger model.
  const struggled = (run?.history ?? []).some(
    (entry) => String(entry.issue) === String(issue.number) && (entry.state === 'failed' || entry.state === 'parked'),
  );
  if ((labels.includes('complexity:high') || struggled) && models.workerComplex) return models.workerComplex;
  if (labels.includes('complexity:low') && models.workerSimple) return models.workerSimple;
  return models.worker ?? null;
}

export function recordOutcome(run, outcome) {
  const next = { ...run, history: [...(run.history ?? []), outcome].slice(-50) };
  next.consecutiveFailures = outcome.state === 'merged' ? 0 : outcome.state === 'failed' ? (run.consecutiveFailures ?? 0) + 1 : (run.consecutiveFailures ?? 0);
  return next;
}
