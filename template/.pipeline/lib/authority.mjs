// Who may post which command. Admins hold every power. A delegate is a separate
// GitHub account, or a GitHub App installation, that the owner grants a subset of
// commands to, in pipeline.config.json:
//
//   "delegates": [{ "login": "gardener", "approve": true,
//                   "decide": ["design", "security", "determination"],
//                   "rearm": true, "direct": true }]
//
// An App delegate names the App in place of a login, and acts as `<slug>[bot]`:
//
//   { "app": { "id": 123456, "slug": "gardener-app" }, "approve": true }
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
// A GitHub App's slug, and the pipeline's own bot, which never counts as a delegate.
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,33}$/i;
export const PIPELINE_BOT = 'github-actions[bot]';
// GitHub Actions' own App id. Its bot is the pipeline's.
export const ACTIONS_APP_ID = 15368;
export const botLogin = (slug) => `${slug}[bot]`;
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

function appProblem(app, trustedBots) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return 'has an "app" that is not an object';
  const unknown = Object.keys(app).find((key) => !['id', 'slug'].includes(key));
  if (unknown) return `has an "app" with an unknown key "${unknown}"`;
  if (!validUserId(app.id)) return 'has an "app" with no valid id';
  if (app.id === ACTIONS_APP_ID) return "names GitHub Actions, the pipeline's own App";
  if (typeof app.slug !== 'string' || !SLUG.test(app.slug)) return 'has an "app" with no valid slug';
  const bot = botLogin(app.slug);
  if (sameLogin(bot, PIPELINE_BOT)) return "names the pipeline's own bot";
  if (trustedBots.some((other) => sameLogin(other, bot))) return 'names a bot in "trustedBots"';
  return null;
}

function entryProblem(entry, admins, trustedBots) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if ('login' in entry === 'app' in entry) return 'needs exactly one of "login" and "app"';
  if ('app' in entry) {
    const problem = appProblem(entry.app, trustedBots);
    if (problem) return problem;
    // An App is pinned by its own id, so a user id has no place here.
    if ('id' in entry) return 'has an "id", which is for a user account; an App is pinned by "app.id"';
  } else {
    if (typeof entry.login !== 'string' || !LOGIN.test(entry.login)) return 'has no valid login';
    if (admins.some((admin) => sameLogin(admin, entry.login))) return 'is also an admin';
  }
  for (const flag of FLAGS) {
    if (flag in entry && typeof entry[flag] !== 'boolean') return `has a non-boolean "${flag}"`;
  }
  if ('decide' in entry) {
    if (!isStringList(entry.decide)) return 'has a "decide" that is not a list of classes';
    const unknown = entry.decide.find((cls) => !DECISION_CLASSES.includes(cls));
    if (unknown !== undefined) return `has an unknown decision class "${unknown}"`;
  }
  // Cleaning writes `since: null` and `id: null` for an entry without them, and the
  // gate cleans a cleaned config again, so null means absent.
  if (entry.since != null && !validSince(entry.since)) return 'has a "since" that is not an ISO date and time';
  if (entry.id != null && !validUserId(entry.id)) return 'has an "id" that is not a GitHub user id';
  return null;
}

// `id`: the delegate account's numeric GitHub user id. A login can change hands;
// the id can't. With it set, only that account's commands count.
export const validUserId = (value) => Number.isSafeInteger(value) && value > 0;

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
  const trustedBots = isStringList(config.trustedBots) ? config.trustedBots : [];
  const kept = [];
  config.delegates.forEach((entry, index) => {
    const problem = entryProblem(entry, admins, trustedBots);
    const login = typeof entry?.app?.slug === 'string' ? botLogin(entry.app.slug) : entry?.login;
    const name = typeof login === 'string' ? `"${login}"` : `#${index + 1}`;
    if (problem) {
      warn(`pipeline.config.json: delegate ${name} ${problem}, so it was dropped.`);
    } else if (kept.some((other) => sameLogin(other.login, login) || (entry.app && other.app?.id === entry.app.id))) {
      warn(`pipeline.config.json: delegate ${name} is listed twice, so the second entry was dropped.`);
    } else {
      kept.push({
        login,
        app: entry.app ? { id: entry.app.id, slug: entry.app.slug } : null,
        approve: entry.approve === true,
        approveExternal: entry.approveExternal === true,
        approveWorkflows: entry.approveWorkflows === true,
        decide: [...(entry.decide ?? [])],
        rearm: entry.rearm === true,
        direct: entry.direct === true,
        since: entry.since ?? null,
        id: entry.id ?? null,
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
    // For what restricts a delegate, such as a push or an edit: by login, or by id
    // when the grant has one, so a renamed account is still caught.
    delegateOfUser: (user) =>
      delegates.find((grant) => sameLogin(grant.login, user?.login) || (grant.id !== null && grant.id === user?.id)) ?? null,
  };
}

// Contract functions take a bare admins list (the original signature), a config,
// or an authority, so existing callers keep working.
export function toAuthority(value) {
  if (Array.isArray(value)) return authority({ admins: value });
  if (value && typeof value.isAdmin === 'function') return value;
  return authority(value ?? {});
}
