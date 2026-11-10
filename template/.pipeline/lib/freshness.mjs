// Branch freshness: whether main has moved under a PR in a way that matters.
//
// Optional, through `freshness` in pipeline.config.json. Without it the gate
// checks nothing here, and GitHub's "require branches to be up to date" rule is
// what keeps merges serial. With `{ "mode": "overlap" }`, a PR that is behind main
// may still merge, unless main has changed since the PR's merge base:
//
// - a file the PR changes,
// - a file in a group the PR also touches (`groups`: name -> globs, one unit), or
// - a floor path, where any change stales every open PR: the pipeline's own
//   files, `.github/`, and dependency manifests and lockfiles. `floor` in config
//   adds to this list. Nothing removes from it.
//
// Then the gate isn't green until the branch is updated. A clean update keeps the
// change hash, so approvals and the council verdict still count after it.
import { matchesAny, normalizePath } from './paths.mjs';

// A change here on main can alter what the gate, CI or the build does for every
// PR, so it stales them all. Dependency files count anywhere in the tree.
export const FRESHNESS_FLOOR = [
  'pipeline.config.json',
  'pipeline.lock.json',
  '.pipeline/**',
  '.claude/hooks/**',
  '.claude/settings*.json',
  '.github/**',
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.toml',
  '**/Cargo.lock',
];

export const STALE_MARKER = '<!-- pipeline:stale -->';
export const STALE_TITLE = 'update the branch';
const MODES = ['overlap'];
const LISTED = 20;

const isGlobList = (value) =>
  Array.isArray(value) && value.every((glob) => typeof glob === 'string' && glob.trim().replace(/\/+$/, '') !== '');

// An entry written as a directory, `schema/` or `schema` with no glob characters,
// means that path and everything under it. Anything else is a glob as written.
export function expandEntries(entries) {
  return entries.flatMap((entry) => {
    if (!entry.endsWith('/') && /[*?]/.test(entry)) return [entry];
    const bare = entry.replace(/\/+$/, '');
    return [bare, `${bare}/**`];
  });
}

// The setting as the gate uses it, or null when absent. Never throws. A present
// but malformed setting fails closed: the gate then needs the branch to include
// every change on main, as GitHub's strict rule would.
export function cleanFreshness(value, warn = () => {}) {
  if (value === undefined) return null;
  // Already cleaned and failed closed: keep it as it is, so cleaning twice changes nothing.
  if (value?.mode === 'current' && typeof value.problem === 'string' && Object.keys(value).length === 2) return { mode: 'current', problem: value.problem };
  const problem = freshnessProblem(value);
  if (problem) {
    warn(`pipeline.config.json: "freshness" ${problem}, so the gate needs every branch up to date with main.`);
    return { mode: 'current', problem };
  }
  return { mode: value.mode, floor: [...(value.floor ?? [])], groups: Object.fromEntries(Object.entries(value.groups ?? {}).map(([name, globs]) => [name, [...globs]])) };
}

function freshnessProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'is not an object';
  if (!MODES.includes(value.mode)) return `has an unknown mode ${JSON.stringify(value.mode)}`;
  const unknown = Object.keys(value).find((key) => !['mode', 'floor', 'groups'].includes(key));
  if (unknown) return `has an unknown key "${unknown}"`;
  if ('floor' in value && !isGlobList(value.floor)) return 'has a "floor" that is not a list of globs';
  if ('groups' in value) {
    const groups = value.groups;
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return 'has "groups" that is not an object';
    const bad = Object.entries(groups).find(([, globs]) => !isGlobList(globs) || globs.length === 0);
    if (bad) return `has a group "${bad[0]}" that is not a list of globs`;
  }
  return null;
}

// Pure: what `mainPaths` (changed on main since the merge base) means for a PR
// that changes `prPaths`. Null when freshness isn't configured.
export function freshnessOf(setting, mainPaths, prPaths) {
  if (!setting) return null;
  const behind = mainPaths.length > 0;
  // Paths compare case-folded, as the tier floors do, so a case change still overlaps.
  const mine = new Set(prPaths.map(normalizePath));
  const both = mainPaths.filter((path) => mine.has(normalizePath(path)));
  const result = { mode: setting.mode, behind, stale: false, sameFiles: both.length > 0, reasons: [], files: [] };
  if (!behind) return result;

  if (setting.mode !== 'overlap') {
    result.stale = true;
    result.reasons.push(`pipeline.config.json's "freshness" ${setting.problem ?? 'is not usable'}, so the branch must include every change on main`);
    result.files = mainPaths;
    return result;
  }

  const floor = mainPaths.filter((path) => matchesAny(path, [...FRESHNESS_FLOOR, ...expandEntries(setting.floor)]));
  if (floor.length > 0) result.reasons.push(`main changed ${list(floor)}, which every open PR must include`);
  if (both.length > 0) result.reasons.push(`main changed ${list(both)}, which this PR also changes`);

  const grouped = [];
  for (const [name, entries] of Object.entries(setting.groups)) {
    const globs = expandEntries(entries);
    const onMain = mainPaths.filter((path) => matchesAny(path, globs));
    if (onMain.length > 0 && prPaths.some((path) => matchesAny(path, globs))) {
      grouped.push(...onMain);
      result.reasons.push(`main changed ${list(onMain)} in the group "${name}", which this PR also touches`);
    }
  }

  result.files = [...new Set([...floor, ...both, ...grouped])];
  result.stale = result.files.length > 0;
  return result;
}

function list(paths) {
  const shown = paths.slice(0, LISTED).map((path) => `\`${path}\``).join(', ');
  return paths.length > LISTED ? `${shown} and ${paths.length - LISTED} more` : shown;
}

// The lines a stale gate shows. The marker lets pr-wait and the inbox tell this
// apart from waiting on a person: updating the branch is a worker's job.
export function staleLines(freshness, defaultBranch = 'main') {
  const after = freshness.sameFiles
    ? 'The update changes what this PR changes, so it needs the council and approval again.'
    : 'This PR changes none of those files, so a clean update keeps its approval and council verdict.';
  return [`This branch needs an update from ${defaultBranch}: ${freshness.reasons.join('; ')}.`, `Merge or rebase ${defaultBranch} into it and push. ${after}`, STALE_MARKER];
}

export const isStaleSummary = (summary) => (summary ?? '').includes(STALE_MARKER);
