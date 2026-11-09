// Frozen copy of this file as it was before delegates existed. Tests compare the
// live code against it to prove that, with no `delegates` key, nothing changed.
// Never edit it.
// The PR contract: what a PR body must say, and the council verdict it carries.

export const REQUIRED_SECTIONS = ['Testing', 'Risk', 'How to revert'];

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

export function sectionBody(body, heading) {
  const lines = stripComments(body ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

export function checkContract(body) {
  const missing = REQUIRED_SECTIONS.filter((heading) => {
    const content = sectionBody(body, heading);
    return !content || /^(todo|tbd|n\/?a)\.?$/i.test(content);
  });
  return { ok: missing.length === 0, missing };
}

const VERDICT_RE = /<!--\s*pipeline:verdict\s*([\s\S]*?)-->/g;

export function parseVerdict(body) {
  const blocks = [...(body ?? '').matchAll(VERDICT_RE)];
  if (blocks.length === 0) return { verdict: null, error: 'missing' };
  try {
    const verdict = JSON.parse(blocks.at(-1)[1]);
    const valid =
      typeof verdict.changeHash === 'string' &&
      Number.isInteger(verdict.tier) &&
      Number.isInteger(verdict.rounds) &&
      Number.isInteger(verdict.open?.blocker) &&
      Number.isInteger(verdict.open?.should);
    return valid ? { verdict, error: null } : { verdict: null, error: 'malformed' };
  } catch {
    return { verdict: null, error: 'malformed' };
  }
}

export function renderVerdict(verdict) {
  return `<!-- pipeline:verdict\n${JSON.stringify(verdict)}\n-->`;
}

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
