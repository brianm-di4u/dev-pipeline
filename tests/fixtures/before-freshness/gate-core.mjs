// Frozen copy of template/.pipeline/lib/gate-core.mjs as it was before branch
// freshness existed. Tests compare the live code against it to prove that, with no
// `freshness` key, nothing changed. Never edit it.
// The merge decision as a pure function, so every rule can be tested without
// GitHub. `gate.mjs` gathers the inputs and publishes the result.
import { authority } from '../../../template/.pipeline/lib/authority.mjs';
import { checkContract, delegateBarriers, delegateRefusals, findApproval, parseVerdict, touchMarkers } from '../../../template/.pipeline/lib/contract.mjs';
import { classify } from '../../../template/.pipeline/lib/tier.mjs';

export function evaluateGate({
  pr,
  changes,
  hash,
  config,
  verify,
  comments = [],
  scriptsChangedIn = [],
  cleanRevert = false,
  adrCited = false,
  mainRed = false,
  citesMainRed = false,
  breakerTripped = false,
  defaultBranch = 'main',
  // Read only when a delegate is configured. Left out, a delegate's approval
  // can't count: the gate fails closed on what it couldn't check.
  commitLogins,
  suspended,
  suspensions,
  // Touch markers from comments and the bot's label events. Left out, they're
  // read from the comments alone.
  touches,
  historyUnreadable = false,
}) {
  const { verdict, error: verdictError } = parseVerdict(pr.body);
  const { tier, reasons, flags } = classify({
    changes,
    config,
    author: pr.author,
    scriptsChangedIn,
    aiRaise: verdict?.raise ?? null,
    cleanRevert,
    adrCited,
  });

  const blockers = [];
  if (pr.draft) blockers.push('PR is a draft.');
  if (pr.base !== defaultBranch) blockers.push(`Base must be ${defaultBranch}, not ${pr.base}.`);

  // A verified clean revert skips review: undoing a merged change must stay
  // fast, and it can only restore a state main already had.
  if (!(cleanRevert && tier === 0)) {
    const contract = checkContract(pr.body);
    if (!contract.ok) blockers.push(`PR contract is missing: ${contract.missing.join(', ')}.`);

    if (verdictError === 'missing') {
      blockers.push('No council verdict in the PR body.');
    } else if (verdictError) {
      blockers.push('Council verdict is malformed.');
    } else {
      if (verdict.changeHash !== hash) {
        blockers.push('Council verdict is for different content. Re-review the changes since then.');
      }
      if (verdict.open.blocker > 0 || verdict.open.should > 0) {
        blockers.push(
          `Council has open findings: ${verdict.open.blocker} blocker, ${verdict.open.should} should.`,
        );
      }
      if (verdict.tier < tier) {
        blockers.push(`Council reviewed at T${verdict.tier}, but this change is T${tier}.`);
      }
    }
  }

  // Skipped doesn't count: GitHub treats a skipped job as passing, so only an
  // explicit success does here.
  let waitingOnVerify = false;
  if (verify === 'pending' || verify === 'missing') waitingOnVerify = true;
  else if (verify !== 'success') blockers.push(`verify concluded ${verify}.`);

  if (mainRed && tier > 0 && !citesMainRed) {
    blockers.push('Main is red. Only a revert or a PR citing the main-red issue can merge.');
  }

  const auth = authority(config);
  const ctx = { flags, author: pr.author, commitLogins, touches: touches ?? touchMarkers(comments), historyUnreadable, suspended, suspensions };
  const approval = findApproval(comments, auth, hash, ctx);
  const policy = config.merge?.[`t${tier}`] ?? 'human';
  const needsHuman = policy !== 'auto' || (breakerTripped && tier > 0);

  const shortHash = hash.slice(0, 12);
  const base = { tier, reasons, hash, shortHash, blockers, approved: approval !== null };

  // With no delegate configured, nothing below adds to the result or its text.
  let delegate = null;
  if (auth.delegates.length > 0) {
    const barriers = Object.fromEntries(auth.delegates.map((grant) => [grant.login, delegateBarriers(auth, grant.login, ctx)]));
    delegate = {
      flags,
      approvalRole: approval?.role ?? null,
      mayApprove: Object.values(barriers).some((list) => list.length === 0),
      barriers,
      refusals: delegateRefusals(comments, auth, hash, ctx).map(({ login, reasons: why }) => ({ login, reasons: why })),
    };
    base.delegate = delegate;
  }

  if (blockers.length > 0) {
    return {
      ...base,
      status: 'completed',
      conclusion: 'failure',
      title: `T${tier}: blocked`,
      summary: render(base, blockers),
    };
  }
  if (waitingOnVerify) {
    return {
      ...base,
      status: 'in_progress',
      conclusion: null,
      title: `T${tier}: waiting on verify`,
      summary: render(base, ['Waiting for verify to finish on the head commit.']),
    };
  }
  if (needsHuman && !approval) {
    const why =
      breakerTripped && policy === 'auto' ? 'The circuit breaker is tripped.' : `T${tier} needs a human.`;
    return {
      ...base,
      status: 'completed',
      conclusion: 'action_required',
      title: `T${tier}: waiting for approval`,
      summary: render(base, [
        `${why} To approve this exact change, comment:\n\n\`/approve ${shortHash}\``,
        ...delegateLines(delegate),
      ]),
    };
  }
  let approvedLine = 'All checks passed.';
  if (approval) {
    approvedLine = `Approved by ${approval.comment.user.login}${approval.role === 'delegate' ? ', a delegate' : ''}.`;
  }
  // With a delegate configured, the check records whose approval it relied on, so
  // post-merge can label the merge then, rather than read comments that can change.
  const marker = delegate ? ['', renderApprovalMarker(approval)] : [];
  return {
    ...base,
    status: 'completed',
    conclusion: 'success',
    title: `T${tier}: ready to merge`,
    summary: render(base, [approvedLine, ...marker]),
  };
}

const APPROVAL_MARKER_RE = /<!--\s*pipeline:approval\s+role=(admin|delegate|none)(?:\s+login=([A-Za-z0-9-]+))?\s*-->/;

export function renderApprovalMarker(approval) {
  if (!approval) return '<!-- pipeline:approval role=none -->';
  return `<!-- pipeline:approval role=${approval.role} login=${approval.comment.user.login} -->`;
}

// Whose approval a gate check relied on, from its summary, or null.
export function approvalOfCheck(summary) {
  const match = APPROVAL_MARKER_RE.exec(summary ?? '');
  return match ? { role: match[1], login: match[2] ?? null } : null;
}

// Who can approve, said where the approver looks: the check summary.
function delegateLines(delegate) {
  if (!delegate) return [];
  const lines = [''];
  if (delegate.mayApprove) {
    lines.push('A delegate may approve this change.');
  } else {
    const why = [...new Set(Object.values(delegate.barriers).flat())];
    lines.push(`Only an admin can approve this change: ${why.join('; ')}.`);
  }
  for (const refusal of delegate.refusals) {
    lines.push(`The approval by ${refusal.login} doesn't count: ${refusal.reasons.join('; ')}.`);
  }
  return lines;
}

function render({ tier, reasons, shortHash }, lines) {
  return [
    `**Tier:** T${tier}`,
    `**Change:** \`${shortHash}\``,
    '',
    '**Why this tier:**',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    ...lines,
  ].join('\n');
}
