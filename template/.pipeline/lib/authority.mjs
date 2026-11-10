// Who may post which command. Admins hold every power. A delegate is a separate
// GitHub account the owner grants a subset of commands to, in pipeline.config.json:
//
//   "delegates": [{ "login": "gardener", "approve": true,
//                   "decide": ["design", "security", "determination"],
//                   "rearm": true, "direct": true }]
//
// With no `delegates` key, nothing here changes how the pipeline behaves.

export const DECISION_CLASSES = ['design', 'determination', 'legal', 'security', 'major'];

// The files that define a delegate's own authority. Only an admin can approve a
// change to them, whatever the project's config says: config can add to this
// list, never take from it. It applies only while a delegate is configured.
export const ADMIN_ONLY_FLOOR = [
  'pipeline.config.json',
  'pipeline.lock.json',
  '.pipeline/**',
  '.claude/hooks/**',
  '.claude/settings*.json',
  '.claude/skills/gardener/**',
  '.github/workflows/gate.yml',
  '.github/workflows/decisions.yml',
  '.github/workflows/post-merge.yml',
  '.github/workflows/audit.yml',
  '.github/workflows/release.yml',
];

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const FLAGS = ['approve', 'approveExternal', 'approveWorkflows', 'rearm', 'direct'];

// A merged workflow with `checks: write` could forge pipeline/gate from main for
// good, so workflows and the actions they use need an admin, unless a delegate's
// grant sets `approveWorkflows`. .claude/agents/** and .claude/workflows/** stay
// delegate-approvable; a project can add them to `tiers.adminOnlyPaths`.
export const WORKFLOW_PATHS = ['.github/workflows/**', '.github/actions/**'];

export const sameLogin = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// `since`: a delegate's commands count only from this moment on. Anything the
// account posted before, such as from a browser left signed in as it before it
// was configured, never counts.
const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const validSince = (value) => typeof value === 'string' && SINCE.test(value) && !Number.isNaN(Date.parse(value));

function entryProblem(entry, admins) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if (typeof entry.login !== 'string' || !LOGIN.test(entry.login)) return 'has no valid login';
  if (admins.some((admin) => sameLogin(admin, entry.login))) return 'is also an admin';
  for (const flag of FLAGS) {
    if (flag in entry && typeof entry[flag] !== 'boolean') return `has a non-boolean "${flag}"`;
  }
  if ('decide' in entry) {
    if (!isStringList(entry.decide)) return 'has a "decide" that is not a list of classes';
    const unknown = entry.decide.find((cls) => !DECISION_CLASSES.includes(cls));
    if (unknown !== undefined) return `has an unknown decision class "${unknown}"`;
  }
  if ('since' in entry && !validSince(entry.since)) return 'has a "since" that is not an ISO date and time';
  return null;
}

// Drops what it can't trust rather than throwing: a throw here would fail the gate
// on every PR. Dropping only ever takes authority away.
export function cleanDelegates(config, warn = () => {}) {
  if (!('delegates' in config)) return undefined;
  if (!Array.isArray(config.delegates)) {
    warn('pipeline.config.json: "delegates" is not a list, so no delegate has any authority.');
    return [];
  }
  const adminOnly = config.tiers?.adminOnlyPaths;
  if (adminOnly !== undefined && !isStringList(adminOnly)) {
    warn('pipeline.config.json: "tiers.adminOnlyPaths" is not a list of paths, so no delegate has any authority.');
    return [];
  }
  const admins = Array.isArray(config.admins) ? config.admins : [];
  const kept = [];
  config.delegates.forEach((entry, index) => {
    const problem = entryProblem(entry, admins);
    const name = typeof entry?.login === 'string' ? `"${entry.login}"` : `#${index + 1}`;
    if (problem) {
      warn(`pipeline.config.json: delegate ${name} ${problem}, so it was dropped.`);
    } else if (kept.some((other) => sameLogin(other.login, entry.login))) {
      warn(`pipeline.config.json: delegate ${name} is listed twice, so the second entry was dropped.`);
    } else {
      kept.push({
        login: entry.login,
        approve: entry.approve === true,
        approveExternal: entry.approveExternal === true,
        approveWorkflows: entry.approveWorkflows === true,
        decide: [...(entry.decide ?? [])],
        rearm: entry.rearm === true,
        direct: entry.direct === true,
        since: entry.since ?? null,
      });
    }
  });
  return kept;
}

export function authority(config) {
  const admins = Array.isArray(config?.admins) ? config.admins : [];
  const delegates = cleanDelegates(config ?? {}) ?? [];
  const adminOnlyPaths =
    delegates.length === 0 ? [] : [...new Set([...ADMIN_ONLY_FLOOR, ...(config.tiers?.adminOnlyPaths ?? [])])];
  return {
    admins,
    delegates,
    adminOnlyPaths,
    isAdmin: (login) => admins.includes(login),
    delegateOf: (login) => delegates.find((grant) => sameLogin(grant.login, login)) ?? null,
  };
}

// Contract functions take a bare admins list (the original signature), a config,
// or an authority, so existing callers keep working.
export function toAuthority(value) {
  if (Array.isArray(value)) return authority({ admins: value });
  if (value && typeof value.isAdmin === 'function') return value;
  return authority(value ?? {});
}
