// Deterministic tier calculation. AI can raise the result through the verdict
// block but nothing can lower it.
import { authority } from './authority.mjs';
import { readBlob } from './git.mjs';
import { matchesAny, normalizePath } from './paths.mjs';

const PLAIN_FILE = new Set(['100644', '000000']);

// A change to `scripts` changes what `verify` runs, so it counts as protected.
// A dependency bump in the same file doesn't.
export function scriptsChanged(changes, baseRef, headRef, cwd) {
  const manifests = changes.filter((c) => normalizePath(c.path).split('/').pop() === 'package.json');
  return manifests
    .filter((c) => {
      const scripts = (ref) => {
        const text = readBlob(ref, c.path, cwd);
        if (text === null) return '{}';
        try {
          return JSON.stringify(JSON.parse(text).scripts ?? {});
        } catch {
          return 'unparseable';
        }
      };
      return scripts(baseRef) !== scripts(headRef);
    })
    .map((c) => c.path);
}

// Besides the tier and its reasons, classify returns `flags`: the facts a delegate's
// approval depends on, as data rather than text.
export function classify({
  changes,
  config,
  author,
  scriptsChangedIn = [],
  aiRaise = null,
  cleanRevert = false,
  adrCited = false,
}) {
  const tiers = config.tiers;
  const reasons = [];
  const paths = changes.map((c) => c.path);
  const isAdmin = config.admins.includes(author);
  const isTrustedBot = (config.trustedBots ?? []).includes(author);
  // Empty unless a delegate is configured.
  const { adminOnlyPaths } = authority(config);
  const flags = {
    external: false,
    adminOnly: [],
    scripts: [...scriptsChangedIn],
    symlinks: [],
    raised: Boolean(aiRaise),
  };

  if (!isAdmin && !isTrustedBot) {
    reasons.push(`External author: ${author}`);
    flags.external = true;
  }

  for (const path of paths) {
    if (matchesAny(path, tiers.t2Paths)) reasons.push(`Protected path: ${path}`);
    // Admin-only paths are T2 too, or a change to one could auto-merge at T1.
    if (matchesAny(path, adminOnlyPaths)) {
      reasons.push(`Admin-only path: ${path}`);
      flags.adminOnly.push(path);
    }
  }
  for (const path of scriptsChangedIn) reasons.push(`package.json scripts changed: ${path}`);

  // A symlink or submodule can point a harmless-looking path anywhere.
  for (const change of changes) {
    if (change.newMode === '120000' || change.newMode === '160000') {
      reasons.push(`Symlink or submodule: ${change.path}`);
      flags.symlinks.push(change.path);
    }
  }

  const decisionPaths = paths.filter((p) => matchesAny(p, tiers.decisionPaths ?? ['docs/decisions/**']));
  if (decisionPaths.length > 0 && !adrCited) {
    reasons.push(`Decision record without a cited /decide: ${decisionPaths[0]}`);
  }

  if (aiRaise) reasons.push(`Raised by council: ${aiRaise.reason ?? 'no reason given'}`);

  if (reasons.length > 0) return { tier: 2, reasons, flags };

  if (cleanRevert) return { tier: 0, reasons: ['Verified clean revert'], flags };

  if (paths.length > 0 && decisionPaths.length === paths.length) {
    return { tier: 0, reasons: ['Decision record citing /decide'], flags };
  }

  const docsOnly =
    paths.length > 0 &&
    changes.every(
      (c) =>
        PLAIN_FILE.has(c.newMode) &&
        matchesAny(c.path, tiers.t0Paths) &&
        !matchesAny(c.path, tiers.t0Exclude),
    );
  if (docsOnly) return { tier: 0, reasons: ['Markdown docs only'], flags };

  return { tier: 1, reasons: ['Default tier'], flags };
}
