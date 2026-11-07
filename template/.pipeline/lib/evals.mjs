// Programmatic grading for the council's evals. A planted bug counts as found only
// if a surviving, blocking finding points at the right place and is about the right
// thing. A clean change passes only if nothing blocking survives.

const BLOCKING = new Set(['blocker', 'should']);
const LINE_SLOP = 3;

function hits(expected, findings, kase) {
  return findings.some((finding) => {
    if (!kase.anySeverity && !BLOCKING.has(finding.severity)) return false;
    if (finding.preExisting) return false;
    if ((finding.file ?? '').replaceAll('\\', '/') !== expected.file) return false;
    const line = finding.line ?? 0;
    if (line < expected.from - LINE_SLOP || line > expected.to + LINE_SLOP) return false;
    const text = `${finding.class ?? ''} ${finding.claim ?? ''} ${finding.fix ?? ''}`.toLowerCase();
    return expected.words.some((word) => text.includes(word.toLowerCase()));
  });
}

export function gradeCase(kase, result) {
  const findings = result?.findings ?? [];
  const blocking = findings.filter((f) => BLOCKING.has(f.severity) && !f.preExisting);
  const incomplete = !result || (result.missing ?? []).length > 0;
  if (kase.kind === 'clean') {
    return { id: kase.id, kind: 'clean', split: kase.split, hard: Boolean(kase.hard), pass: !incomplete && blocking.length === 0, falseAlarms: blocking.length, incomplete };
  }
  // A bug in an unchanged caller can fairly be reported at either end of the break.
  const found = kase.expect.filter(
    (expected, index) => hits(expected, findings, kase) || (kase.alsoAccept?.[index] && hits(kase.alsoAccept[index], findings, kase)),
  );
  return {
    id: kase.id,
    kind: 'bug',
    split: kase.split,
    hard: Boolean(kase.hard),
    pass: !incomplete && found.length === kase.expect.length,
    found: found.length,
    expected: kase.expect.length,
    extraBlocking: Math.max(0, blocking.length - found.length),
    incomplete,
  };
}

function summarizeGroup(grades) {
  const bugs = grades.filter((g) => g.kind === 'bug');
  const clean = grades.filter((g) => g.kind === 'clean');
  return {
    bugCases: bugs.length,
    bugsFound: bugs.reduce((sum, g) => sum + g.found, 0),
    bugsExpected: bugs.reduce((sum, g) => sum + g.expected, 0),
    recall: bugs.length ? bugs.reduce((sum, g) => sum + g.found, 0) / bugs.reduce((sum, g) => sum + g.expected, 0) : null,
    cleanCases: clean.length,
    cleanPassed: clean.filter((g) => g.pass).length,
    falseAlarms: clean.reduce((sum, g) => sum + g.falseAlarms, 0),
    incomplete: grades.filter((g) => g.incomplete).length,
  };
}

export function scoreCases(grades) {
  return {
    all: summarizeGroup(grades),
    train: summarizeGroup(grades.filter((g) => g.split === 'train')),
    test: summarizeGroup(grades.filter((g) => g.split === 'test')),
    hard: summarizeGroup(grades.filter((g) => g.hard)),
    missed: grades.filter((g) => g.kind === 'bug' && !g.pass).map((g) => g.id),
    falseAlarmCases: grades.filter((g) => g.kind === 'clean' && !g.pass).map((g) => g.id),
  };
}
