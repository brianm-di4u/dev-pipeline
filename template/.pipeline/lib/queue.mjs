// Autopilot's decisions as plain code: whether to keep going, and what to do next.

const DAY = 24 * 60 * 60 * 1000;

// Issues from outsiders never start work, whatever labels they carry. Agent-filed
// issues carry the owner's login, so they arrive labeled `triage` and need a
// verifier before they count as `ready`.
export function eligible(issue, admins) {
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  return (
    !issue.pull_request &&
    issue.state === 'open' &&
    admins.includes(issue.user?.login) &&
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

export function pickNext(issues, admins) {
  return [...issues.filter((issue) => eligible(issue, admins))].sort(
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

  const issue = pickNext(issues, config.admins);
  if (!issue) return { action: 'stop', reason: 'The ready queue is empty.' };
  return { action: 'work', issue: { number: issue.number, title: issue.title }, reason: `${mergedToday} of ${budget} PRs merged today.` };
}

export function recordOutcome(run, outcome) {
  const next = { ...run, history: [...(run.history ?? []), outcome].slice(-50) };
  next.consecutiveFailures = outcome.state === 'merged' ? 0 : outcome.state === 'failed' ? (run.consecutiveFailures ?? 0) + 1 : (run.consecutiveFailures ?? 0);
  return next;
}
