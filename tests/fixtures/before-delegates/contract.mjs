// Frozen copy of the command parsers in contract.mjs as they were before delegates
// existed. Tests compare the live code against it to prove that, with no
// `delegates` key, nothing changed. Never edit it. The PR contract and verdict
// parsers didn't change, so they're re-exported rather than copied.
export { REQUIRED_SECTIONS, checkContract, parseVerdict, renderVerdict, sectionBody } from '../../../template/.pipeline/lib/contract.mjs';

// Commands count only as a comment's entire body, from an admin, never edited.
// A comment that quotes a command therefore does nothing.
const isOriginalAdminComment = (comment, admins) =>
  admins.includes(comment.user?.login) &&
  comment.user?.type !== 'Bot' &&
  comment.created_at === comment.updated_at;

export function findApproval(comments, admins, hash) {
  return (
    comments.find((comment) => {
      if (!isOriginalAdminComment(comment, admins)) return false;
      const match = /^\/approve ([0-9a-f]{12,64})$/.exec((comment.body ?? '').trim());
      return match !== null && hash.startsWith(match[1]);
    }) ?? null
  );
}

export function findDecision(comments, admins) {
  for (const comment of comments) {
    if (!isOriginalAdminComment(comment, admins)) continue;
    const match = /^\/decide ([A-Za-z0-9._-]+)$/.exec((comment.body ?? '').trim());
    if (match) return { option: match[1], comment };
  }
  return null;
}

export function hasRearm(comments, admins) {
  return comments.some(
    (comment) => isOriginalAdminComment(comment, admins) && (comment.body ?? '').trim() === '/rearm',
  );
}
