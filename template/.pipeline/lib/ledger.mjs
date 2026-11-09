// Council bookkeeping. Which seats run, how many rounds a change gets, and when
// review stops all live here as plain code, so convergence doesn't depend on a
// model remembering the rules. Upstream's unbounded loop is what produced an
// 80,000-line PR; this is the fix.
import { matchesAny } from './paths.mjs';

export const SEVERITIES = ['blocker', 'should', 'nit'];
const BLOCKING = new Set(['blocker', 'should']);

// How many rounds each tier gets before the author has to step back.
export function budgetFor(tier, council) {
  if (tier === 0) return 1;
  if (tier === 2) return council.maxRoundsSensitive ?? 5;
  return council.maxRounds ?? 3;
}

export const DEFAULT_TRIGGERS = {
  ui: ['**/*.html', '**/*.css', '**/*.scss', '**/*.jsx', '**/*.tsx', '**/*.vue', '**/*.svelte', '**/ui/**'],
  runtime: [
    '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.jsx', '**/*.tsx', '**/*.rs', '**/*.py', '**/*.go',
    '**/*.swift', '**/*.kt', '**/*.sql', '**/*.c', '**/*.cpp', '**/*.h',
  ],
  content: [
    '**/package.json', '**/package-lock.json', '**/Cargo.toml', '**/Cargo.lock', '**/assets/**', '**/data/**',
    '**/content/**', 'THIRD_PARTY*', 'LICENSE*',
  ],
};

const ALWAYS = ['council-bug-hunter', 'council-minimalist'];
const T1_CORE = ['council-security-auditor', 'council-evidence-auditor'];
// Most droppable first. Security and architect never drop on T2.
const DROP_ORDER = ['council-ux-a11y-reviewer', 'council-reliability-engineer', 'council-legal-reviewer'];

export function selectSeats({ tier, paths, council = {}, diffLines = 0 }) {
  const triggers = { ...DEFAULT_TRIGGERS, ...council.triggers };
  const code = paths.filter((p) => !matchesAny(p, ['**/*.md', 'tests/**', '**/*.test.*']));
  const touches = (globs) => code.some((p) => matchesAny(p, globs));

  if (tier === 0) {
    return {
      seats: ALWAYS.map((agent) => ({ agent, model: 'sonnet' })),
      panel: ['sonnet'],
      dropped: [],
    };
  }

  const wanted = [...ALWAYS, ...T1_CORE];
  const structural =
    tier === 2 ||
    diffLines > (council.structuralLines ?? 400) ||
    paths.some((p) => matchesAny(p, ['docs/decisions/**']));
  if (structural) wanted.push('council-architect');
  if (touches(triggers.content)) wanted.push('council-legal-reviewer');
  if (touches(triggers.runtime)) wanted.push('council-reliability-engineer');
  if (touches(triggers.ui)) wanted.push('council-ux-a11y-reviewer');

  // A project's own seats, each called for by the paths it names. They're the last
  // to drop: a project adds one because no generic seat can do its job.
  const extras = (council.extraSeats ?? []).filter((seat) => touches(seat.paths)).map((seat) => seat.agent);
  wanted.push(...extras);

  const limit = council.maxSeats ?? 6;
  const dropped = [];
  for (const seat of [...DROP_ORDER, ...extras]) {
    if (wanted.length <= limit) break;
    const index = wanted.indexOf(seat);
    if (index !== -1) {
      wanted.splice(index, 1);
      dropped.push(seat);
    }
  }

  const model = tier === 1 ? council.t1Model : null;
  return {
    seats: wanted.map((agent) => (model ? { agent, model } : { agent })),
    panel: tier === 2 ? ['sonnet', 'sonnet', 'opus'] : ['sonnet', 'sonnet'],
    dropped,
  };
}

export function emptyLedger() {
  return { rounds: [], findings: [], nextId: 1, steppedBack: false, confirmUsed: false, growthAccepted: null, raise: null };
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'when', 'which', 'bug', 'class', 'missing', 'error', 'issue', 'problem']);
const words = (text) =>
  new Set((text ?? '').toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((word) => !STOPWORDS.has(word)) ?? []);
const overlap = (a, b) => [...a].filter((word) => b.has(word)).length;

// Seats reword a finding from round to round, and fixes shift its line, so a repeat
// is the same file, a nearby line, and the same subject.
export function sameFinding(a, b) {
  if ((a.file ?? '') !== (b.file ?? '')) return false;
  if (Math.abs((a.line ?? 0) - (b.line ?? 0)) > 5) return false;
  if (overlap(words(a.class), words(b.class)) > 0) return true;
  const claimA = words(a.claim);
  const claimB = words(b.claim);
  const shared = overlap(claimA, claimB);
  return shared > 0 && shared / new Set([...claimA, ...claimB]).size >= 0.25;
}

const unanswered = (ledger) => ledger.findings.filter((f) => f.status === 'open');
const blockingOpen = (ledger) => unanswered(ledger).filter((f) => BLOCKING.has(f.severity));

export function nextStep({ ledger, tier, hash, council, cleanTree, evidenceOk, diffLines }) {
  // Stepping back and re-approaching earns one fresh, full round.
  const budget = budgetFor(tier, council) + (ledger.steppedBack ? 1 : 0);
  const counted = ledger.rounds.filter((r) => r.mode !== 'confirm');
  const last = ledger.rounds.at(-1);
  const base = { tier, hash, budget, roundsUsed: counted.length };

  if (!cleanTree) return { ...base, status: 'commit-first', message: 'Commit everything first. The council reviews commits.' };
  if (!evidenceOk) {
    return { ...base, status: 'prove-first', message: 'Run node .pipeline/verify.mjs full on this exact change first.' };
  }
  if (last && !last.complete) {
    // Timeout or no reply isn't approval. Rerun the same round.
    return { ...base, status: 'review', mode: last.mode, round: last.number, message: 'The last round was incomplete: a seat or voter gave no answer. Run it again.' };
  }
  if (blockingOpen(ledger).length > 0) {
    return {
      ...base,
      status: 'answer-findings',
      message: 'Answer every open blocker and should first, with: node .pipeline/council.mjs resolve',
      open: blockingOpen(ledger),
    };
  }

  if (last && last.hash === hash) {
    return { ...base, status: 'done', message: 'The council has reviewed this exact change. Render the verdict.' };
  }

  const firstLines = ledger.rounds[0]?.diffLines ?? null;
  const growth = council.maxDiffGrowth ?? 1.5;
  if (firstLines !== null && diffLines > Math.max(firstLines * growth, firstLines + 40) && !ledger.growthAccepted) {
    return {
      ...base,
      status: 'cut-first',
      message: `The diff grew from ${firstLines} to ${diffLines} lines during review. Cut what the intent doesn't need. If the growth is justified: node .pipeline/council.mjs accept-growth "reason"`,
    };
  }

  if (counted.length === 0) return { ...base, status: 'review', mode: 'full', round: 1 };
  if (counted.length < budget) {
    const fresh = ledger.steppedBack && counted.length === budget - 1;
    return { ...base, status: 'review', mode: fresh ? 'full' : 'diff', round: counted.length + 1 };
  }

  // Budget spent, but the last fix hasn't been checked. One free confirmation
  // keeps a good final fix from wedging the PR.
  if (!ledger.confirmUsed) {
    return { ...base, status: 'review', mode: 'confirm', round: counted.length, message: 'Budget spent. One diff-only confirmation of the last fix, which does not count.' };
  }
  if (!ledger.steppedBack) {
    return {
      ...base,
      status: 'step-back',
      message: 'The budget is spent and the change still is not settling. Reconsider the approach rather than patching further, then run: node .pipeline/council.mjs step-back',
    };
  }
  return {
    ...base,
    status: 'parked',
    message: 'This change has not converged, even after re-approaching it. Stop, leave the PR open, summarize both sides on it, and move on.',
  };
}

export function recordRound(ledger, { mode, round, hash, sha, diffLines, result }) {
  const seen = [...ledger.findings];
  const added = [];
  const repeats = [];
  let nits = ledger.findings.filter((f) => f.severity === 'nit').length;
  const maxNits = result.maxNits ?? 5;
  const droppedNits = [];

  // An incomplete round is rerun, so its findings arrive with the rerun.
  const incomplete = (result.missing ?? []).length > 0;
  const ordered = [...(incomplete ? [] : (result.findings ?? []))].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  for (const finding of ordered) {
    if (seen.some((earlier) => sameFinding(earlier, finding))) {
      repeats.push(finding);
      continue;
    }
    seen.push(finding);
    if (finding.preExisting) {
      ledger.findings.push({ ...finding, id: `P${ledger.nextId++}`, status: 'pre-existing', round });
      continue;
    }
    if (finding.severity === 'nit') {
      if (nits >= maxNits) {
        droppedNits.push(finding);
        continue;
      }
      nits += 1;
      // Declined by default: an agent fixing a nit costs another round.
      ledger.findings.push({ ...finding, id: `N${ledger.nextId++}`, status: 'declined', disposition: 'deferred', round });
      continue;
    }
    const entry = { ...finding, id: `S${ledger.nextId++}`, status: 'open', round };
    ledger.findings.push(entry);
    added.push(entry);
    if (finding.raise && !ledger.raise) ledger.raise = finding.raise;
  }

  const complete = (result.missing ?? []).length === 0;
  // A rerun replaces an incomplete round, so a timeout doesn't use up the budget.
  if (ledger.rounds.at(-1)?.complete === false) ledger.rounds.pop();
  ledger.rounds.push({
    number: round,
    mode,
    hash,
    sha,
    diffLines,
    complete,
    seats: result.seats ?? [],
    missing: result.missing ?? [],
    refuted: result.refuted ?? 0,
  });
  if (mode === 'confirm' && complete) ledger.confirmUsed = true;
  return { added, repeats, droppedNits, complete };
}

const DISPOSITIONS = new Set(['fixed', 'wrong', 'intentional', 'wont-matter', 'deferred']);

export function resolveFinding(ledger, id, disposition, reason) {
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error(`Disposition must be one of: ${[...DISPOSITIONS].join(', ')}`);
  }
  const finding = ledger.findings.find((f) => f.id === id);
  if (!finding) throw new Error(`No finding ${id}`);
  if (disposition !== 'fixed' && !reason) throw new Error(`Declining ${id} needs a written reason.`);
  finding.status = disposition === 'fixed' ? 'fixed' : 'declined';
  finding.disposition = disposition;
  finding.reason = reason ?? null;
  return finding;
}

export function buildVerdict({ ledger, tier, hash }) {
  const last = ledger.rounds.at(-1);
  if (!last) throw new Error('The council has not reviewed this change.');
  if (last.hash !== hash) throw new Error('The last round reviewed different content. Run another round.');
  if (!last.complete) throw new Error('The last round was incomplete.');
  const open = blockingOpen(ledger);
  if (open.length > 0) throw new Error(`Open findings: ${open.map((f) => f.id).join(', ')}`);

  const counted = ledger.rounds.filter((r) => r.mode !== 'confirm');
  const count = (severity) =>
    ledger.findings.filter((f) => f.severity === severity && f.status === 'open').length;
  return {
    schema: 1,
    changeHash: hash,
    tier: ledger.raise ? Math.max(tier, 2) : tier,
    rounds: counted.length,
    open: { blocker: count('blocker'), should: count('should'), nit: ledger.findings.filter((f) => f.severity === 'nit').length },
    ...(ledger.raise ? { raise: ledger.raise } : {}),
    // Self-reported by `council.mjs plan --worker <model>`, for the digest.
    ...(ledger.worker ? { worker: { model: ledger.worker } } : {}),
    seats: [...new Set(ledger.rounds.flatMap((r) => r.seats))],
    diff: { first: ledger.rounds[0]?.diffLines ?? 0, final: last.diffLines },
    findings: ledger.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      class: f.class ?? null,
      disposition: f.disposition ?? f.status,
    })),
  };
}
