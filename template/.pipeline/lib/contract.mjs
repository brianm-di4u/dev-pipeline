// The PR contract: what a PR body must say, and the council verdict it carries.
import { sameLogin, toAuthority } from './authority.mjs';

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

// Commands count only as a comment's entire body, from an admin or a delegate,
// never edited, never from a Bot account. A comment that quotes a command
// therefore does nothing. `auth` is a bare admins list, a config, or an authority.
export function actorOf(comment, auth) {
  if (!comment || comment.user?.type === 'Bot' || comment.created_at !== comment.updated_at) return null;
  const who = toAuthority(auth);
  const login = comment.user?.login;
  if (who.isAdmin(login)) return 'admin';
  if (who.delegateOf(login)) return 'delegate';
  return null;
}

const BOT = 'github-actions[bot]';
const isBotComment = (comment) => comment?.user?.login === BOT && comment?.user?.type === 'Bot';

// The gate marks a PR the moment a delegate pushes to it or edits its body, so a
// delegate can't change what it then approves. Only the bot's own marker counts.
const TOUCH_RE = /<!--\s*pipeline:delegate-touch\b([^>]*)-->/;

export function touchMarkers(comments) {
  return (comments ?? [])
    .filter((comment) => isBotComment(comment) && TOUCH_RE.test(comment.body ?? ''))
    .map((comment) => {
      const attrs = TOUCH_RE.exec(comment.body)[1];
      return {
        kind: /\bkind=(\w+)/.exec(attrs)?.[1] ?? null,
        login: /\blogin=([A-Za-z0-9-]+)/.exec(attrs)?.[1] ?? null,
        at: comment.created_at,
      };
    });
}

const time = (value) => (value ? Date.parse(value) : Number.NaN);

// Suspension windows are [from, to). An open window has no `to`.
export function inWindow(at, windows) {
  const moment = time(at);
  return (windows ?? []).some(
    ({ from, to }) => moment >= time(from) && (to === null || to === undefined || moment < time(to)),
  );
}

const APPROVE_RE = /^\/approve ([0-9a-f]{12,64})$/;

const approvesHash = (comment, hash) => {
  const match = APPROVE_RE.exec((comment.body ?? '').trim());
  return match !== null && hash.startsWith(match[1]);
};

// Why a delegate's approval of this change would not count, whatever its comment.
// `ctx` comes from the gate: classify's flags, the PR author, the logins on its
// commits, the delegate-touch markers, and the suspension state. A missing input
// is a reason: the gate fails closed on what it couldn't check.
export function delegateBarriers(auth, login, ctx = {}) {
  const who = toAuthority(auth);
  const grant = who.delegateOf(login);
  if (!grant) return [`${login} is not a delegate`];
  const reasons = [];
  if (!grant.approve) reasons.push(`${grant.login} has no approve grant`);

  const flags = ctx.flags;
  if (!flags) {
    reasons.push('the gate could not classify the change');
  } else {
    if (flags.adminOnly?.length) reasons.push(`it touches an admin-only path: ${flags.adminOnly.join(', ')}`);
    if (flags.symlinks?.length) reasons.push(`it adds a symlink or submodule: ${flags.symlinks.join(', ')}`);
    if (flags.scripts?.length) reasons.push(`it changes package.json scripts: ${flags.scripts.join(', ')}`);
    if (flags.external && !grant.approveExternal) reasons.push(`it is from an outside author: ${ctx.author ?? 'unknown'}`);
  }

  if (sameLogin(ctx.author, grant.login)) reasons.push(`${grant.login} opened this PR`);
  if (!Array.isArray(ctx.commitLogins)) {
    reasons.push("the gate could not read this PR's commit authors");
  } else if (ctx.commitLogins.some((other) => sameLogin(other, grant.login))) {
    reasons.push(`${grant.login} authored or committed to this PR`);
  }
  const touches = ctx.touches ?? [];
  if (touches.length > 0) {
    const kinds = [...new Set(touches.map((touch) => (touch.kind === 'body' ? 'edited its body' : 'pushed to it')))];
    reasons.push(`a delegate ${kinds.join(' and ')}`);
  }
  if (ctx.suspended === undefined || !Array.isArray(ctx.suspensions)) {
    reasons.push('the gate could not read the delegate suspension state');
  } else if (ctx.suspended) {
    reasons.push('delegates are suspended');
  }
  return reasons;
}

function delegateProblems(comment, who, ctx) {
  const reasons = delegateBarriers(who, comment.user.login, ctx);
  if (inWindow(comment.created_at, ctx.suspensions)) reasons.push('it was posted while delegates were suspended');
  return reasons;
}

// The first approval of this exact change that counts, as { comment, role }, or
// null. It keeps looking past a void delegate approval, so one can never shadow a
// later admin approval.
export function findApproval(comments, auth, hash, ctx = {}) {
  const who = toAuthority(auth);
  const context = { ...ctx, touches: ctx.touches ?? touchMarkers(comments) };
  for (const comment of comments) {
    const role = actorOf(comment, who);
    if (!role || !approvesHash(comment, hash)) continue;
    if (role === 'admin') return { comment, role };
    if (delegateProblems(comment, who, context).length === 0) return { comment, role };
  }
  return null;
}

// Every delegate approval of this change that doesn't count, and why.
export function delegateRefusals(comments, auth, hash, ctx = {}) {
  const who = toAuthority(auth);
  const context = { ...ctx, touches: ctx.touches ?? touchMarkers(comments) };
  return comments
    .filter((comment) => actorOf(comment, who) === 'delegate' && approvesHash(comment, hash))
    .map((comment) => ({ comment, login: comment.user.login, reasons: delegateProblems(comment, who, context) }))
    .filter((refusal) => refusal.reasons.length > 0);
}

export function findDecision(comments, auth) {
  const who = toAuthority(auth);
  for (const comment of comments) {
    if (actorOf(comment, who) !== 'admin') continue;
    const match = /^\/decide ([A-Za-z0-9._-]+)$/.exec((comment.body ?? '').trim());
    if (match) return { option: match[1], comment };
  }
  return null;
}

export function hasRearm(comments, auth) {
  const who = toAuthority(auth);
  return comments.some((comment) => actorOf(comment, who) === 'admin' && (comment.body ?? '').trim() === '/rearm');
}
