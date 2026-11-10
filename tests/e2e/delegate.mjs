#!/usr/bin/env node
// End-to-end checks of a delegate approver against the sandbox repo,
// brianm-di4u/pipeline-sandbox. Every result is read from GitHub's own state.
//
// The delegate's token never leaves the delegate's own clone, so no process
// holds both identities. The run is split in three, and the halves coordinate
// only through GitHub: a run issue the admin side opens, and a comment the
// delegate side leaves on it.
//
//   node tests/e2e/delegate.mjs setup    <sandbox-clone>   Admin side: open the fixtures
//   node tests/e2e/delegate.mjs delegate <sandbox-clone>   Delegate side, in the delegate's clone
//   node tests/e2e/delegate.mjs verify   <sandbox-clone>   Admin side: check, then drive the suspension
//   node tests/e2e/delegate.mjs lifted   <sandbox-clone>   Admin side: check the lift, then clean up
//
// The admin side runs where `gh` is the admin's account. It never posts an
// approve, decide or rearm command: the admin posts those by hand. The delegate
// side runs in a Claude Code session opened in the delegate's own clone, where
// `gh` is the delegate. It never posts a command either. It prints them, and the
// session posts each one with `gh`, so they go through the real guard hook.
//
// The delegate side checks who it is first, and skips cleanly, exiting 0, when
// `gh` isn't the delegate (gwb-gardener, or PIPELINE_DELEGATE_LOGIN). The sandbox
// must run this version of the pipeline with that delegate under `delegates` in
// pipeline.config.json on main. See docs/sandbox-results.md for the run plan.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [mode, dirArg] = process.argv.slice(2);
const MODES = ['setup', 'delegate', 'verify', 'lifted'];
if (!MODES.includes(mode)) {
  console.error(`Usage: node tests/e2e/delegate.mjs <${MODES.join('|')}> <sandbox-clone>`);
  process.exit(2);
}
const dir = resolve(dirArg ?? '.');
const EXPECTED = process.env.PIPELINE_DELEGATE_LOGIN || 'gwb-gardener';
const RUN_TITLE = 'Delegate e2e run ';
const MANIFEST_RE = /<!--\s*pipeline:e2e-run\s*([\s\S]*?)-->/;
const DELEGATE_RE = /<!--\s*pipeline:e2e-delegate\s*([\s\S]*?)-->/;

const sh = (command, args, input) =>
  execFileSync(command, args, { cwd: dir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const run = (command, args, input) => {
  const result = spawnSync(command, args, { cwd: dir, input, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};
const git = (...args) => sh('git', args);
const gh = (...args) => sh('gh', args);
const api = (path) => JSON.parse(gh('api', path));
const post = (path, body) => JSON.parse(sh('gh', ['api', '-X', 'POST', path, '--input', '-'], JSON.stringify(body)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// An App delegate's installation token can't name itself through `gh api user`, so
// its session reads the login the token hook recorded. See docs/AGENT-TOKEN.md.
const me = process.env.PIPELINE_DELEGATE_DIR
  ? JSON.parse(readFileSync(join(process.env.PIPELINE_DELEGATE_DIR, 'identity.json'), 'utf8')).login
  : gh('api', 'user', '--jq', '.login');
// From the remote, not `gh repo view`, so the delegate side needs no GraphQL here.
const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'))[1];
const mainConfig = () => JSON.parse(Buffer.from(api(`repos/${repo}/contents/pipeline.config.json?ref=main`).content, 'base64').toString('utf8'));
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

const LABELS = {
  'admin-needed': 'b60205',
  garden: '0e8a16',
  'pipeline:delegate-touched': 'd93f0b',
  'pipeline:delegate-approved': 'c5def5',
  'pipeline:delegate-rearmed': 'c5def5',
  'pipeline:delegate-suspended': 'b60205',
};

const CONTRACT = '## Testing\nDelegate e2e fixture.\n\n## Risk\nSandbox only.\n\n## How to revert\nClose it, or revert the squash commit.\n';
const verdict = (hash, tier, extra = {}) =>
  `\n<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier, rounds: 1, open: { blocker: 0, should: 0 }, ...extra })}\n-->\n`;

function write(path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
async function hashOf() {
  const { changeSet } = await import(`file:///${join(dir, '.pipeline/lib/git.mjs').replaceAll('\\', '/')}`);
  return changeSet('origin/main', 'HEAD', dir).hash;
}
function freshBranch(name) {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  git('checkout', '-q', '-B', name);
}
function commitAndPush(message, branch) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  git('push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`);
}
function openPr(title, body) {
  const file = join(dir, '.git', 'e2e-body.md');
  writeFileSync(file, body);
  return Number(gh('pr', 'create', '--title', title, '--body-file', file).split('/').pop());
}
function openIssue(title, body, labels) {
  const file = join(dir, '.git', 'e2e-body.md');
  writeFileSync(file, body);
  return Number(gh('issue', 'create', '--title', title, '--body-file', file, ...labels.flatMap((l) => ['--label', l])).split('/').pop());
}
const comments = (number) => api(`repos/${repo}/issues/${number}/comments?per_page=100`);
const eventsOf = (number) => api(`repos/${repo}/issues/${number}/events?per_page=100`);
const headOf = (number) => api(`repos/${repo}/pulls/${number}`).head.sha;
const gateCheck = (sha) =>
  api(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent('pipeline/gate')}&filter=all`).check_runs.sort((a, b) => b.id - a.id)[0] ?? null;

// A failed probe, such as a TLS handshake timeout, is retried until the deadline.
async function until(what, probe, timeout = 600000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${lastError ? `; last error: ${lastError.message.split('\n')[0]}` : ''}`);
    }
    await sleep(8000);
  }
}
const botSaid = (number, pattern) => comments(number).find((c) => c.user.login === 'github-actions[bot]' && pattern.test(c.body)) ?? null;
const settled = (number, want) =>
  until(`#${number}'s gate to reach ${want.join(' or ')}`, () => {
    const check = gateCheck(headOf(number));
    return check?.status === 'completed' && want.includes(check.conclusion) ? check : null;
  });

function findRun() {
  const admins = mainConfig().admins;
  const issue = api(`repos/${repo}/issues?state=open&per_page=50`).find(
    (i) => !i.pull_request && i.title.startsWith(RUN_TITLE) && admins.some((a) => same(a, i.user.login)),
  );
  if (!issue) throw new Error(`no open "${RUN_TITLE}<id>" issue from an admin. Run setup first.`);
  return { issue: issue.number, created: issue.created_at, manifest: JSON.parse(MANIFEST_RE.exec(issue.body)[1]) };
}
const delegateReport = (number, delegate) =>
  comments(number)
    .filter((c) => same(c.user.login, delegate) && DELEGATE_RE.test(c.body))
    .map((c) => JSON.parse(DELEGATE_RE.exec(c.body)[1]))
    .at(-1) ?? null;

const results = [];
function check(id, title, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ` (${detail})` : ''}`);
}
async function checkAsync(id, title, body) {
  try {
    check(id, title, true, (await body()) ?? '');
  } catch (error) {
    check(id, title, false, error.message);
  }
}
function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

// ---------------------------------------------------------------------------
// setup: the admin side opens every fixture, then a run issue naming them.
// ---------------------------------------------------------------------------

async function setup() {
  const config = mainConfig();
  if (!config.admins.some((a) => same(a, me))) throw new Error(`setup runs as an admin; gh is ${me}`);
  const grant = (config.delegates ?? []).find((d) => same(d.app ? `${d.app.slug}[bot]` : d.login, EXPECTED));
  if (!grant) throw new Error(`${EXPECTED} isn't under "delegates" in ${repo}'s config on main`);
  const id = Date.now().toString(36);
  // Labels the run needs. The bot makes most of its own, but not all of them yet.
  for (const [name, color] of Object.entries(LABELS)) {
    run('gh', ['label', 'create', name, '--color', color, '--force']);
  }
  const prs = {};
  const hashes = {};
  const branches = {};
  const make = async (key, path, tier, extra) => {
    const branch = `e2e/delegate-${id}-${key.toLowerCase()}`;
    freshBranch(branch);
    write(path, `export const e2e = '${id}-${key}';\n`);
    commitAndPush(`Delegate e2e ${id}: ${key}`, branch);
    const hash = await hashOf();
    prs[key] = openPr(`Delegate e2e ${id}: ${key}`, `${CONTRACT}${verdict(hash, tier, extra)}`);
    hashes[key] = hash.slice(0, 12);
    branches[key] = branch;
  };
  await make('D1', `src/auth/e2e-${id}-d1.js`, 2);
  await make('D2', `.pipeline/e2e-${id}.mjs`, 2);
  // A token without the workflows permission may not push here. Then this case is skipped.
  try {
    await make('D2b', `.github/actions/e2e-${id}/action.yml`, 2);
  } catch (error) {
    console.log(`Skipping D2b: ${error.message.split('\n')[0]}`);
  }
  await make('D4b', `src/auth/e2e-${id}-d4b.js`, 2);
  await make('D4c', `src/auth/e2e-${id}-d4c.js`, 2);
  // T1 paths, raised to T2 by the council, so their reverts are clean and need no one.
  await make('D6a', `src/e2e/${id}-bad-a.js`, 2, { raise: { reason: 'delegate e2e' } });
  await make('D6b', `src/e2e/${id}-bad-b.js`, 2, { raise: { reason: 'delegate e2e' } });
  git('checkout', '-q', 'main');

  const decision = (cls) =>
    openIssue(`Decision: delegate e2e ${id} ${cls}`, `**Class:** ${cls}\n\n**Context:** delegate e2e.\n\n- **A (recommended):** yes\n- **B:** no\n`, ['decision-needed']);
  const issues = { legal: decision('legal'), design: decision('design') };
  for (const number of Object.values(prs)) await settled(number, ['action_required', 'failure']);
  for (const number of Object.values(issues)) await until(`a class record on #${number}`, () => botSaid(number, /pipeline:decision-class/));

  const manifest = { id, delegate: EXPECTED, prs, hashes, branches, issues, decide: grant.decide ?? [] };
  const runIssue = openIssue(
    `${RUN_TITLE}${id}`,
    `Fixtures for a delegate e2e run. The delegate side reads this.\n\n<!-- pipeline:e2e-run ${JSON.stringify(manifest)} -->\n`,
    [],
  );
  console.log(`Run ${id} is ready in #${runIssue}. Next: the delegate side, in the delegate's clone.`);
}

// ---------------------------------------------------------------------------
// delegate: the delegate side, in the delegate's own clone and session.
// ---------------------------------------------------------------------------

function guardSays(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const result = spawnSync('node', [join(dir, '.claude', 'hooks', 'guard.mjs')], { cwd: dir, input, encoding: 'utf8' });
  return result.status === 0 && result.stdout === '' ? 'allow' : 'deny';
}

// The delegate's token is a classic one with only public_repo and workflow, which
// some gh commands' GraphQL queries need more than (gh pr edit asks for org data,
// which needs read:org). So the delegate side uses REST for every write. The
// only GraphQL it relies on is the session's own `gh issue|pr comment`, which the
// guard requires for a command word.
//
// It is resumable: each step checks GitHub for its own result first, so a second
// run picks up where the first stopped and never repeats a push or an issue.
const patch = (path, body) => JSON.parse(sh('gh', ['api', '-X', 'PATCH', path, '--input', '-'], JSON.stringify(body)));
const remoteHas = (branch) => run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]).ok;
const titled = (list, title) => list.find((item) => item.title === title && same(item.user?.login, me)) ?? null;

async function delegateSide() {
  if (!same(me, EXPECTED)) {
    console.log(`SKIP delegate side: gh is ${me}, not ${EXPECTED}. Run it in a session opened in the delegate's clone.`);
    return;
  }
  const { issue: runIssue, manifest, created } = findRun();
  const { prs, hashes, branches, id } = manifest;
  // Start from a clean checkout of main, whatever a stopped run left behind.
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');

  // D5: the guard, run here with this session's environment. Safe to repeat.
  const approve = `gh pr comment ${prs.D1} --body "/approve ${hashes.D1}"`;
  const guard = {
    plainApprove: guardSays(approve),
    droppedToken: guardSays(`unset GH_TOKEN; ${approve}`),
    viaApi: guardSays(`gh api repos/${repo}/issues/${prs.D1}/comments -f body="/approve ${hashes.D1}"`),
    release: guardSays('gh release create v9.9.9'),
  };
  const done = [];

  // D4b: push one commit to a worker's branch, once.
  const pushed = api(`repos/${repo}/pulls/${prs.D4b}/commits?per_page=100`).some((c) => c.commit.message.startsWith(`Delegate e2e ${id}: delegate push`));
  git('fetch', '-q', 'origin', branches.D4b);
  git('checkout', '-q', '-B', branches.D4b, `origin/${branches.D4b}`);
  if (!pushed) {
    write(`src/auth/e2e-${id}-d4b-delegate.js`, 'export const pushedByDelegate = true;\n');
    commitAndPush(`Delegate e2e ${id}: delegate push`, branches.D4b);
  } else done.push('D4b push');
  // The push changed D4b's content, so its approval names the hash after the push.
  const d4bHash = (await hashOf()).slice(0, 12);
  git('checkout', '-q', 'main');

  // D4c: edit a worker's PR body through REST, once. The edit history records it.
  const target = api(`repos/${repo}/pulls/${prs.D4c}`);
  if (!target.body.includes('Edited by the delegate.')) patch(`repos/${repo}/pulls/${prs.D4c}`, { body: `${target.body}\n\nEdited by the delegate.\n` });
  else done.push('D4c edit');

  // D4a: the delegate's own PR, once.
  const ownTitle = `Delegate e2e ${id}: D4a`;
  let own = titled(api(`repos/${repo}/pulls?state=open&per_page=100`), ownTitle);
  let ownHash;
  if (own) {
    ownHash = /"changeHash":"([0-9a-f]{64})"/.exec(own.body)[1].slice(0, 12);
    done.push('D4a PR');
  } else {
    const branch = `e2e/delegate-${id}-d4a`;
    if (remoteHas(branch)) {
      git('fetch', '-q', 'origin', branch);
      git('checkout', '-q', '-B', branch, `origin/${branch}`);
    } else {
      freshBranch(branch);
      write(`src/auth/e2e-${id}-d4a.js`, 'export const ownPr = true;\n');
      commitAndPush(`Delegate e2e ${id}: delegate's own PR`, branch);
    }
    const full = await hashOf();
    ownHash = full.slice(0, 12);
    own = post(`repos/${repo}/pulls`, { title: ownTitle, head: branch, base: 'main', body: `${CONTRACT}${verdict(full, 2)}` });
    git('checkout', '-q', 'main');
  }

  // D3c: a decision issue the delegate opened. D10: an escalation. Once each.
  const issues = api(`repos/${repo}/issues?state=open&creator=${encodeURIComponent(me)}&per_page=100`);
  const decisionTitle = `Decision: delegate e2e ${id} opened by the delegate`;
  let ownDecision = titled(issues, decisionTitle)?.number;
  if (ownDecision) done.push('D3c issue');
  else ownDecision = post(`repos/${repo}/issues`, { title: decisionTitle, body: '**Class:** design\n\n- **A (recommended):** yes\n', labels: ['decision-needed'] }).number;
  const escalationTitle = `Admin needed: delegate e2e ${id}`;
  let escalation = titled(issues, escalationTitle)?.number;
  if (escalation) done.push('D10 issue');
  else escalation = post(`repos/${repo}/issues`, { title: escalationTitle, body: 'Delegate e2e: an escalation. Nothing is waiting on it.', labels: ['admin-needed'] }).number;
  await until(`a class record on #${ownDecision}`, () => botSaid(ownDecision, /pipeline:decision-class/));

  // D7: try to promote a release, once. The guard denies the command in this
  // session, so this calls the API directly, to prove release.yml refuses on its own.
  const earlier = api(`repos/${repo}/actions/workflows/release.yml/runs?per_page=20`).workflow_runs.find(
    (r) => same(r.actor?.login, me) && r.created_at >= created,
  );
  let release;
  if (earlier) {
    release = { requested: earlier.created_at, dispatched: true, detail: '' };
    done.push('D7 dispatch');
  } else {
    const requested = new Date().toISOString();
    const dispatch = run('gh', ['api', '-X', 'POST', `repos/${repo}/actions/workflows/release.yml/dispatches`, '-f', 'ref=main', '-f', `inputs[promote]=v0.0.0-e2e-${id}`]);
    release = { requested, dispatched: dispatch.ok, detail: dispatch.ok ? '' : dispatch.out.split('\n')[0] };
  }

  if (!delegateReport(runIssue, me)) {
    const report = { ownPr: own.number, ownHash, ownDecision, escalation, guard, release };
    post(`repos/${repo}/issues/${runIssue}/comments`, { body: `Delegate side of run ${id} done.\n\n<!-- pipeline:e2e-delegate ${JSON.stringify(report)} -->` });
  }

  if (done.length > 0) console.log(`Already done in an earlier run, not repeated: ${done.join(', ')}.`);
  console.log(`Guard in this session: ${JSON.stringify(guard)}`);
  console.log('\nNow post each of these yourself, one command per tool call, exactly as written:\n');
  if (process.platform === 'win32') {
    console.log('Use the PowerShell tool, not Bash. Git Bash rewrites a leading slash into a Windows path,');
    console.log('so "/approve <hash>" reaches GitHub as "C:/Program Files/Git/approve <hash>" and counts as nothing.\n');
  }
  const lines = [
    approve,
    `gh pr comment ${prs.D2} --body "/approve ${hashes.D2}"`,
    ...(prs.D2b ? [`gh pr comment ${prs.D2b} --body "/approve ${hashes.D2b}"`] : []),
    `gh pr comment ${own.number} --body "/approve ${ownHash}"`,
    `gh pr comment ${prs.D4b} --body "/approve ${d4bHash}"`,
    `gh pr comment ${prs.D4c} --body "/approve ${hashes.D4c}"`,
    `gh issue comment ${manifest.issues.legal} --body "/decide A"`,
    `gh issue comment ${manifest.issues.design} --body "/decide A"`,
    `gh issue comment ${ownDecision} --body "/decide A"`,
    `gh pr comment ${prs.D6a} --body "/approve ${hashes.D6a}"`,
    `gh pr comment ${prs.D6b} --body "/approve ${hashes.D6b}"`,
  ];
  console.log(lines.join('\n'));
  console.log('\nIf the guard denies the first one, or gh refuses it, stop and report the exact message.');
}

// ---------------------------------------------------------------------------
// verify: the admin side checks the delegate's run, then drives the suspension.
// ---------------------------------------------------------------------------

const refusal = (number, delegate, pattern) =>
  until(`a refusal on #${number}`, () =>
    comments(number).find((c) => c.user.login === 'github-actions[bot]' && c.body.startsWith(`The approval by ${delegate} doesn't count`) && pattern.test(c.body)),
  );
const UNREADABLE = /could not read this PR's push and edit history/;

// Main requires branches to be up to date, so bring the PR up to date first. An
// update by the admin keeps the change hash, so an approval still counts.
async function mergeWhenGreen(number) {
  run('gh', ['pr', 'update-branch', String(number)]);
  await settled(number, ['success']);
  gh('pr', 'merge', String(number), '--squash', '--auto');
  await until(`#${number} to merge`, () => api(`repos/${repo}/pulls/${number}`).merged);
}

async function verify() {
  const { issue: runIssue, manifest } = findRun();
  const { prs, hashes, issues, delegate, id } = manifest;
  const report = await until('the delegate side to report', () => delegateReport(runIssue, delegate));
  const admins = mainConfig().admins;

  // A command Git Bash rewrote into a path never counts. Say so now, rather than
  // after every check below times out waiting for it.
  const targets = [...Object.values(prs), report.ownPr, issues.legal, issues.design, report.ownDecision];
  for (const number of targets) {
    const own = comments(number).filter((c) => same(c.user.login, delegate));
    const rewritten = own.find((c) => /^\S+\/(approve|decide|rearm)\b/.test(c.body));
    if (rewritten && !own.some((c) => /^\/(approve|decide|rearm)\b/.test(c.body))) {
      console.log(`WARN #${number}: the delegate's command reached GitHub as "${rewritten.body}". Post it again with the PowerShell tool.`);
    }
  }

  check('D5a', 'the guard allows the delegate one plain approval', report.guard.plainApprove === 'allow', report.guard.plainApprove);
  check('D5b', 'the guard denies the delegate a command that drops its token first', report.guard.droppedToken === 'deny');
  check('D5c', 'the guard denies the delegate a command word through gh api', report.guard.viaApi === 'deny');
  check('D5d', "the guard denies the delegate's session a release", report.guard.release === 'deny');

  await checkAsync('D1', 'a delegate approval turns a T2 PR green, with a quiet record', async () => {
    const green = await settled(prs.D1, ['success']);
    const record = await until('the approval record', () => botSaid(prs.D1, /^Delegate approval by /));
    if (admins.some((a) => record.body.includes(`@${a}`))) throw new Error('the record pings an admin');
    if (!/pipeline:approval role=delegate/.test(green.output.summary)) throw new Error('the check does not record the delegate approval');
    return green.output.title;
  });
  await checkAsync('D2', 'an admin-only path stays held', async () => {
    await refusal(prs.D2, delegate, /admin-only path/);
    return (await settled(prs.D2, ['action_required'])).output.title;
  });
  if (prs.D2b) {
    await checkAsync('D2b', 'an action change needs approveWorkflows', async () => (await refusal(prs.D2b, delegate, /approveWorkflows/), 'refused'));
  }
  await checkAsync('D3a', 'a legal decision ignores the delegate', async () => {
    await until('a legal refusal', () => botSaid(issues.legal, /doesn't count: .*may not decide legal/));
    if (api(`repos/${repo}/issues/${issues.legal}`).labels.some((l) => l.name === 'decided')) throw new Error('labelled decided');
  });
  if (manifest.decide.includes('design')) {
    await checkAsync('D3b', 'a design decision is recorded for the delegate', async () => (await until('a record', () => botSaid(issues.design, /^Delegate decision by .* recorded/)), 'recorded'));
  }
  await checkAsync('D3c', 'the delegate cannot decide an issue it opened', async () =>
    (await until('a refusal', () => botSaid(report.ownDecision, /not an admin/)), 'refused'),
  );
  await checkAsync('D4a', 'the delegate cannot approve its own PR', async () => (await refusal(report.ownPr, delegate, /opened this PR|authored or committed/), 'refused'));
  await checkAsync('D4b', 'the delegate cannot approve a PR it pushed to', async () => {
    await refusal(prs.D4b, delegate, /pushed to it/);
    if (!eventsOf(prs.D4b).some((e) => e.event === 'labeled' && e.label?.name === 'pipeline:delegate-touched' && e.actor?.login === 'github-actions[bot]')) {
      throw new Error('no touch label event');
    }
  });
  await checkAsync('D4c', 'the delegate cannot approve a PR whose body it edited', async () => (await refusal(prs.D4c, delegate, /edited its body/), 'refused'));
  await checkAsync('H1', "the Actions token reads the activity log and edit history", async () => {
    for (const number of [prs.D1, prs.D2, prs.D4b, prs.D4c, report.ownPr]) {
      if (comments(number).some((c) => UNREADABLE.test(c.body))) throw new Error(`#${number}: the gate could not read the history`);
    }
  });
  await checkAsync('D10', 'an admin-needed issue pings the admins', async () => (await until('a ping', () => botSaid(report.escalation, /this needs you/)), 'pinged'));
  await checkAsync('D7', 'release.yml refuses the delegate', async () => {
    if (!report.release.dispatched) return `refused at dispatch: ${report.release.detail}`;
    const runInfo = await until('the release run to finish', () =>
      api(`repos/${repo}/actions/workflows/release.yml/runs?per_page=20`).workflow_runs.find(
        (r) => same(r.actor?.login, delegate) && r.created_at >= report.release.requested.slice(0, 19) && r.status === 'completed',
      ),
    );
    const jobs = api(`repos/${repo}/actions/runs/${runInfo.id}/jobs`).jobs;
    if (!jobs.every((job) => job.conclusion === 'skipped')) throw new Error(jobs.map((j) => `${j.name}=${j.conclusion}`).join(', '));
    return `run ${runInfo.id}: every job skipped`;
  });

  // D6: merge the two delegate-approved PRs, then revert both.
  await checkAsync('D6', 'two bad delegate-approved merges suspend delegates', async () => {
    const shas = [];
    for (const key of ['D6a', 'D6b']) {
      await mergeWhenGreen(prs[key]);
      const merged = api(`repos/${repo}/pulls/${prs[key]}`);
      await until(`#${prs[key]} to be labelled delegate-approved`, () =>
        eventsOf(prs[key]).some((e) => e.event === 'labeled' && e.label?.name === 'pipeline:delegate-approved' && e.actor?.login === 'github-actions[bot]'),
      );
      shas.push(merged.merge_commit_sha);
    }
    for (const sha of shas) {
      const branch = `e2e/delegate-${id}-revert-${sha.slice(0, 7)}`;
      freshBranch(branch);
      git('revert', '--no-edit', sha);
      git('push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`);
      const number = openPr(`Delegate e2e ${id}: revert ${sha.slice(0, 7)}`, `${CONTRACT}Revert-of: ${sha}\n`);
      await mergeWhenGreen(number);
    }
    git('checkout', '-q', 'main');
    const suspension = await until('a suspension issue', () =>
      api(`repos/${repo}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=50`).find((i) => i.title.startsWith('Delegates suspended')),
    );
    const republished = await until('a re-published gate on D1', () => {
      const latest = gateCheck(headOf(prs.D1));
      return /^republish:/.test(latest?.external_id ?? '') && latest.conclusion === 'action_required' ? latest : null;
    });
    console.log(`\nSuspended in #${suspension.number}. D1 re-published: ${republished.output.title}.`);
    console.log(`Next: in the delegate's session, gh issue comment ${suspension.number} --body "/rearm" (it must be refused).`);
    console.log(`Then the admin, by hand: /rearm on #${suspension.number}. Then: node tests/e2e/delegate.mjs lifted <clone>`);
    return `#${suspension.number}`;
  });
  await checkAsync('G1', 'no merge in the run was taken for a forged gate', async () => {
    const forged = api(`repos/${repo}/issues?state=open&labels=pipeline%3Aaudit&per_page=50`).filter((i) => /did not come from the gate/.test(i.title));
    if (forged.length > 0) throw new Error(forged.map((i) => `#${i.number}`).join(', '));
  });
  finish();
}

// ---------------------------------------------------------------------------
// lifted: after the delegate's refused /rearm and the admin's /rearm.
// ---------------------------------------------------------------------------

async function lifted() {
  const { issue: runIssue, manifest } = findRun();
  const { prs, id } = manifest;
  const suspension = api(`repos/${repo}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=50`).find((i) => i.title.startsWith('Delegates suspended'));
  await checkAsync('D6c', "the delegate's /rearm doesn't lift a suspension", async () => (await until('a refusal', () => botSaid(suspension.number, /Only an admin can lift/)), 'refused'));
  await checkAsync('D6d', "the admin's /rearm lifts it", async () => {
    await until('the lift', () => botSaid(suspension.number, /Delegates are back on/));
    if (api(`repos/${repo}/issues/${suspension.number}`).state !== 'closed') throw new Error('still open');
  });
  await checkAsync('D6e', 'the lift re-runs the gate for PRs it held', async () => {
    const latest = await until('D1 back to green', () => {
      const c = gateCheck(headOf(prs.D1));
      return /^republish:/.test(c?.external_id ?? '') && c.conclusion === 'success' ? c : null;
    });
    return latest.output.title;
  });
  finish();
  // Clean up: close every fixture still open, and the run issue.
  const open = api(`repos/${repo}/pulls?state=open&per_page=100`).filter((pr) => pr.title.startsWith(`Delegate e2e ${id}`));
  for (const pr of open) run('gh', ['pr', 'close', String(pr.number), '--delete-branch']);
  const openIssues = api(`repos/${repo}/issues?state=open&per_page=100`).filter((i) => !i.pull_request && i.title.includes(`delegate e2e ${id}`));
  for (const issue of openIssues) run('gh', ['issue', 'close', String(issue.number)]);
  run('gh', ['issue', 'close', String(runIssue)]);
}

const modes = { setup, delegate: delegateSide, verify, lifted };
await modes[mode]().catch((error) => {
  console.error(`FAIL ${mode}: ${error.message}`);
  process.exitCode = 1;
});
