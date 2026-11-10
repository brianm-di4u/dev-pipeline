// The PR contract: what a PR body must say, and the council verdict it carries.
import { DECISION_CLASSES, sameLogin, toAuthority } from './authority.mjs';

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
// never edited. A comment that quotes a command therefore does nothing. A Bot
// account counts only as the bot of an App delegate, and then only as that
// delegate; whether the App really posted it is identityProblems' to say.
// `auth` is a bare admins list, a config, or an authority.
export function actorOf(comment, auth) {
  if (!comment || comment.created_at !== comment.updated_at) return null;
  const who = toAuthority(auth);
  const login = comment.user?.login;
  if (comment.user?.type === 'Bot') return who.delegateOf(login)?.app ? 'delegate' : null;
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
    if (flags.workflows?.length && !grant.approveWorkflows) {
      reasons.push(`it changes a workflow or action, and ${grant.login} has no approveWorkflows grant: ${flags.workflows.join(', ')}`);
    }
  }

  if (sameLogin(ctx.author, grant.login)) reasons.push(`${grant.login} opened this PR`);
  if (!Array.isArray(ctx.commitLogins)) {
    reasons.push("the gate could not read this PR's commit authors");
  } else if (ctx.commitLogins.some((other) => sameLogin(other, grant.login))) {
    reasons.push(`${grant.login} authored or committed to this PR`);
  }
  const touches = ctx.touches ?? [];
  const TOUCH_WORDS = { push: 'pushed to it', body: 'edited its body' };
  const kinds = [...new Set(touches.map((touch) => TOUCH_WORDS[touch.kind]).filter(Boolean))];
  if (kinds.length > 0) reasons.push(`a delegate ${kinds.join(' and ')}`);
  if (touches.some((touch) => !TOUCH_WORDS[touch.kind])) reasons.push('the bot has marked it as touched by a delegate');
  if (ctx.historyUnreadable) reasons.push("the gate could not read this PR's push and edit history");
  if (ctx.suspended === undefined || !Array.isArray(ctx.suspensions)) {
    reasons.push('the gate could not read the delegate suspension state');
  } else if (ctx.suspended) {
    reasons.push('delegates are suspended');
  }
  return reasons;
}

// A login is only as durable as the account behind it. So a delegate's command,
// or an issue it opens, counts only when GitHub itself says on it that the author
// has access to the repository, and, with an `id` in the grant, only from that
// exact account. A missing field fails.
export const ACCESS = ['COLLABORATOR', 'MEMBER', 'OWNER'];

export function identityProblems(item, grant) {
  if (grant.app) return appIdentityProblems(item, grant);
  const reasons = [];
  const association = item?.author_association;
  if (!ACCESS.includes(association)) {
    reasons.push(`GitHub doesn't show ${grant.login} with access to this repository on it (${association ?? 'no association given'})`);
  }
  if (grant.id !== null && grant.id !== undefined && item?.user?.id !== grant.id) {
    reasons.push(`it came from account ${item?.user?.id ?? 'unknown'}, not ${grant.login}'s configured id ${grant.id}`);
  }
  return reasons;
}

// An App delegate's proof is GitHub's record of which App posted it: an
// installation token only writes where the App is installed. A bot is never a
// collaborator, so its author_association isn't asked for. A missing field fails.
function appIdentityProblems(item, grant) {
  const reasons = [];
  if (item?.user?.type !== 'Bot') reasons.push(`it was not posted by ${grant.login}, an App`);
  if (!sameLogin(item?.user?.login, grant.login)) reasons.push(`it was posted by ${item?.user?.login ?? 'unknown'}, not ${grant.login}`);
  const via = item?.performed_via_github_app?.id;
  if (via !== grant.app.id) reasons.push(`GitHub doesn't record it as posted through App ${grant.app.id} (${via ?? 'no App recorded'})`);
  return reasons;
}

// A command posted before the grant's `since` never counts.
function beforeGrant(grant, comment) {
  return grant?.since ? time(comment.created_at) < time(grant.since) : false;
}
const BEFORE_GRANT = (grant) => `it was posted before ${grant.login}'s grant began, at ${grant.since}`;

function delegateProblems(comment, who, ctx) {
  const reasons = delegateBarriers(who, comment.user.login, ctx);
  if (inWindow(comment.created_at, ctx.suspensions)) reasons.push('it was posted while delegates were suspended');
  const grant = who.delegateOf(comment.user.login);
  if (grant) reasons.push(...identityProblems(comment, grant));
  if (beforeGrant(grant, comment)) reasons.push(BEFORE_GRANT(grant));
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

// A decision request's class, from its body: the issue form renders
// `### Class\n\n<class>`, and the decision skill writes `**Class:** <class>`.
// Anything ambiguous or unknown is null: unclassified, so only an admin decides.
export function parseDecisionClass(body) {
  const text = (body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const found = new Set();
  for (const match of text.matchAll(/^###[ \t]*Class[ \t]*\n+[ \t]*(\S[^\n]*?)[ \t]*$/gim)) found.add(match[1].toLowerCase());
  for (const match of text.matchAll(/^[ \t]*(?:[-*][ \t]+)?\*\*Class:\*\*[ \t]*(\S[^\n]*?)[ \t]*$/gim)) {
    found.add(match[1].toLowerCase());
  }
  if (found.size !== 1) return null;
  const [cls] = found;
  return DECISION_CLASSES.includes(cls) ? cls : null;
}

// The bot records the class when the issue is labelled, so nobody can lower it
// later by editing the body. The earliest unedited bot marker wins. If any of the
// bot's comments on the issue was edited, the record is untrustworthy, and the
// issue counts as unclassified.
const CLASS_MARKER_RE = /<!--\s*pipeline:decision-class\s+([a-z-]+)\s*-->/;

export const renderClassMarker = (cls) => `<!-- pipeline:decision-class ${cls ?? 'unclassified'} -->`;

// `events` is the issue's event list. With it, the marker must answer the issue's
// first decision-needed labelling: a marker after a later labelling means an
// earlier one was deleted, so the class counts as unclassified. Nobody can delete
// an event.
export function recordedClass(comments, events) {
  const bot = (comments ?? []).filter(isBotComment);
  const markers = bot
    .filter((comment) => CLASS_MARKER_RE.test(comment.body ?? ''))
    .sort((a, b) => time(a.created_at) - time(b.created_at) || (a.id ?? 0) - (b.id ?? 0));
  if (markers.length === 0) return null;
  const first = markers[0];
  const cls = CLASS_MARKER_RE.exec(first.body)[1];
  let tampered = bot.some((comment) => comment.created_at !== comment.updated_at);
  if (Array.isArray(events)) {
    const labelled = events
      .filter((event) => event.event === 'labeled' && event.label?.name === 'decision-needed')
      .map((event) => time(event.created_at))
      .sort((a, b) => a - b);
    const at = time(first.created_at);
    if (labelled.length === 0 || at < labelled[0] || (labelled.length > 1 && at >= labelled[1])) tampered = true;
  }
  return { class: !tampered && DECISION_CLASSES.includes(cls) ? cls : null, at: first.created_at };
}

const DECIDE_RE = /^\/decide ([A-Za-z0-9._-]+)$/;

// Why a delegate's /decide on this issue would not count. `ctx.issueAuthor` and
// `ctx.events` are the issue's author and event list; without them it can't count.
// On a public repo anyone can open a decision issue, and the form labels it for
// them, so a delegate decides only issues an admin opened.
export function decisionProblems(comment, auth, comments, ctx = {}) {
  const who = toAuthority(auth);
  const grant = who.delegateOf(comment.user?.login);
  if (!grant) return [`${comment.user?.login} is not a delegate`];
  const recorded = recordedClass(comments, ctx.events);
  const reasons = [...identityProblems(comment, grant)];
  if (beforeGrant(grant, comment)) reasons.push(BEFORE_GRANT(grant));
  if (ctx.issueAuthor === undefined) reasons.push("the issue's author could not be read");
  else if (!who.isAdmin(ctx.issueAuthor)) reasons.push(`the issue was opened by ${ctx.issueAuthor}, not an admin`);
  if (!Array.isArray(ctx.events)) reasons.push("the issue's label history could not be read");
  if (!recorded?.class) {
    reasons.push('the bot has no class on record for this issue, so only an admin can decide it');
  } else {
    if (!grant.decide.includes(recorded.class)) reasons.push(`${grant.login} may not decide ${recorded.class} questions`);
    if (!(time(recorded.at) < time(comment.created_at))) reasons.push('it was posted before the bot recorded the class');
  }
  // council.mjs plans offline and can't read suspension. The gate re-checks.
  if (!ctx.ignoreSuspension) {
    if (ctx.suspended === undefined || !Array.isArray(ctx.suspensions)) {
      reasons.push('the delegate suspension state could not be read');
    } else if (ctx.suspended) {
      reasons.push('delegates are suspended');
    } else if (inWindow(comment.created_at, ctx.suspensions)) {
      reasons.push('it was posted while delegates were suspended');
    }
  }
  return reasons;
}

// The /decide that counts, as { option, comment, role, class }, or null. Any
// admin's beats every delegate's, whatever the order; among admins the first
// counts, as it always has. A delegate's counts only for a class in its grant that
// the bot recorded before the comment, on an issue an admin opened, and not while
// suspended.
export function findDecision(comments, auth, ctx = {}) {
  const who = toAuthority(auth);
  let delegated = null;
  for (const comment of comments) {
    const role = actorOf(comment, who);
    if (!role) continue;
    const match = DECIDE_RE.exec((comment.body ?? '').trim());
    if (!match) continue;
    if (role === 'admin') return { option: match[1], comment, role, class: recordedClass(comments, ctx.events)?.class ?? null };
    if (!delegated && decisionProblems(comment, who, comments, ctx).length === 0) {
      delegated = { option: match[1], comment, role, class: recordedClass(comments, ctx.events).class };
    }
  }
  return delegated;
}

export const isDecideCommand = (comment) => DECIDE_RE.test((comment?.body ?? '').trim());

// The bot grants a delegate one re-arm per breaker trip by posting this, unedited,
// on the breaker issue.
const REARM_OK_RE = /<!--\s*pipeline:delegate-rearm-ok\s*-->/;
export const REARM_OK_MARKER = '<!-- pipeline:delegate-rearm-ok -->';

export function rearmGrant(comments) {
  return (
    (comments ?? [])
      .filter((comment) => isBotComment(comment) && comment.created_at === comment.updated_at && REARM_OK_RE.test(comment.body ?? ''))
      .sort((a, b) => time(a.created_at) - time(b.created_at))[0] ?? null
  );
}

// Why a delegate's /rearm on this breaker issue would not count.
export function rearmProblems(comment, auth, comments, ctx = {}) {
  const who = toAuthority(auth);
  const grant = who.delegateOf(comment.user?.login);
  if (!grant) return [`${comment.user?.login} is not a delegate`];
  const reasons = [...identityProblems(comment, grant)];
  if (!grant.rearm) reasons.push(`${grant.login} has no rearm grant`);
  if (beforeGrant(grant, comment)) reasons.push(BEFORE_GRANT(grant));
  const ok = rearmGrant(comments);
  if (!ok) reasons.push('the bot did not offer a delegate re-arm for this trip, so only an admin can re-arm it');
  else if (!(time(ok.created_at) < time(comment.created_at))) reasons.push('it was posted before the bot offered a delegate re-arm');
  // Judged by when it was posted, not by today's state: a re-arm made before a
  // suspension stays made. The open window covers one posted during it.
  if (!Array.isArray(ctx.suspensions)) {
    reasons.push('the delegate suspension state could not be read');
  } else if (inWindow(comment.created_at, ctx.suspensions)) {
    reasons.push('it was posted while delegates were suspended');
  }
  return reasons;
}

export const isRearmCommand = (comment) => (comment?.body ?? '').trim() === '/rearm';
export const isApproveCommand = (comment) => APPROVE_RE.test((comment?.body ?? '').trim());
export const approvedHash = (comment) => APPROVE_RE.exec((comment?.body ?? '').trim())?.[1] ?? null;

// The first /rearm on a breaker issue that counts, as { role, comment }, or null.
// For the delegate-suspension issue, use hasRearm: only an admin lifts that.
export function rearmBy(comments, auth, ctx = {}) {
  const who = toAuthority(auth);
  for (const comment of comments) {
    const role = actorOf(comment, who);
    if (!role || !isRearmCommand(comment)) continue;
    if (role === 'admin') return { role, comment };
    if (rearmProblems(comment, who, comments, ctx).length === 0) return { role, comment };
  }
  return null;
}

export function hasRearm(comments, auth) {
  const who = toAuthority(auth);
  return comments.some((comment) => actorOf(comment, who) === 'admin' && (comment.body ?? '').trim() === '/rearm');
}
