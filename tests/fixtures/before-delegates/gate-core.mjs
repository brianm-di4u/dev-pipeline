// Frozen copy of this file as it was before delegates existed. Tests compare the
// live code against it to prove that, with no `delegates` key, nothing changed.
// Never edit it.
// The merge decision as a pure function, so every rule can be tested without
// GitHub. `gate.mjs` gathers the inputs and publishes the result.
import { checkContract, findApproval, parseVerdict } from './contract.mjs';
import { classify } from './tier.mjs';

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
}) {
  const { verdict, error: verdictError } = parseVerdict(pr.body);
  const { tier, reasons } = classify({
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

  const approval = findApproval(comments, config.admins, hash);
  const policy = config.merge?.[`t${tier}`] ?? 'human';
  const needsHuman = policy !== 'auto' || (breakerTripped && tier > 0);

  const shortHash = hash.slice(0, 12);
  const base = { tier, reasons, hash, shortHash, blockers, approved: approval !== null };

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
      summary: render(base, [`${why} To approve this exact change, comment:\n\n\`/approve ${shortHash}\``]),
    };
  }
  return {
    ...base,
    status: 'completed',
    conclusion: 'success',
    title: `T${tier}: ready to merge`,
    summary: render(base, [approval ? `Approved by ${approval.user.login}.` : 'All checks passed.']),
  };
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
