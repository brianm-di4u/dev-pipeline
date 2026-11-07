// Verifies a claimed clean revert. The PR must exactly invert a commit already
// on the base branch, touch no protected path, and not itself undo a revert.
import { commitMessage, isAncestor, rawChanges, tryGit } from './git.mjs';
import { matchesAny } from './paths.mjs';

const REVERT_OF = /^Revert-of:\s*([0-9a-f]{7,40})\s*$/im;

export function claimedRevert(body) {
  return REVERT_OF.exec(body ?? '')?.[1] ?? null;
}

export function verifyCleanRevert({ claimed, changes, baseRef, config, cwd }) {
  const commit = tryGit(['rev-parse', '--verify', `${claimed}^{commit}`], cwd)?.trim();
  if (!commit) return { ok: false, reason: `Unknown commit ${claimed}` };
  if (!isAncestor(commit, baseRef, cwd)) return { ok: false, reason: `${claimed} is not on the base branch` };

  const message = commitMessage(commit, cwd);
  if (/^Revert\b/i.test(message) || REVERT_OF.test(message)) {
    return { ok: false, reason: `${claimed} is itself a revert` };
  }

  const original = rawChanges(`${commit}^1`, commit, cwd);
  const protectedPath = original.find((c) => matchesAny(c.path, config.tiers.t2Paths));
  if (protectedPath) return { ok: false, reason: `Touches protected path ${protectedPath.path}` };

  const inverse = new Map(
    original.map((c) => [c.path, `${c.newMode} ${c.oldMode} ${c.newSha} ${c.oldSha}`]),
  );
  const exact =
    changes.length === original.length &&
    changes.every((c) => inverse.get(c.path) === `${c.oldMode} ${c.newMode} ${c.oldSha} ${c.newSha}`);
  return exact ? { ok: true, commit } : { ok: false, reason: `Not an exact inverse of ${claimed}` };
}
