#!/usr/bin/env node
// End-to-end checks of branch freshness against the sandbox repo,
// brianm-di4u/pipeline-sandbox. Every result is read from GitHub's own state.
//
//   node tests/e2e/freshness.mjs verdicts <sandbox-clone>      The gate's verdicts, with GitHub's up-to-date rule on or off
//   node tests/e2e/freshness.mjs merge-behind <sandbox-clone>  Only after the admin turned the up-to-date rule off
//
// It runs as an admin, where `gh` is the admin's account, and never posts an
// approve, decide or rearm command: every fixture is T1, which the sandbox merges
// on its own, with a fixture council verdict in the body. The sandbox's main must
// run this version of the pipeline, with this in pipeline.config.json:
//
//   "freshness": { "mode": "overlap", "groups": { "e2e": ["e2e-group/**"] } }
//
// and with gate.yml running on a push to main. See docs/sandbox-results.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [mode, dirArg] = process.argv.slice(2);
const MODES = ['verdicts', 'merge-behind'];
if (!MODES.includes(mode)) {
  console.error(`Usage: node tests/e2e/freshness.mjs <${MODES.join('|')}> <sandbox-clone>`);
  process.exit(2);
}
const dir = resolve(dirArg ?? '.');

const sh = (command, args, input) =>
  execFileSync(command, args, { cwd: dir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};
const git = (...args) => sh('git', args);
const gh = (...args) => sh('gh', args);
const api = (path) => JSON.parse(gh('api', path));
const patch = (path, body) => JSON.parse(sh('gh', ['api', '-X', 'PATCH', path, '--input', '-'], JSON.stringify(body)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'))[1];
const fileOnMain = (path) => Buffer.from(api(`repos/${repo}/contents/${path}?ref=main`).content, 'base64').toString('utf8');
const MARKER = '<!-- pipeline:stale -->';

const CONTRACT = '## Testing\nFreshness e2e fixture.\n\n## Risk\nSandbox only.\n\n## How to revert\nClose it, or revert the squash commit.\n';
const verdict = (hash) => `<!-- pipeline:verdict\n${JSON.stringify({ changeHash: hash, tier: 1, rounds: 1, open: { blocker: 0, should: 0 } })}\n-->`;
const lines = (changed = {}) => `${Array.from({ length: 10 }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

async function hashOf() {
  const { changeSet } = await import(`file:///${join(dir, '.pipeline/lib/git.mjs').replaceAll('\\', '/')}`);
  return changeSet('origin/main', 'HEAD', dir).hash;
}
function freshBranch(name) {
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  git('checkout', '-q', '-B', name);
}

// A T1 PR from the current main, changing `files` (null deletes a path).
async function fixture(title, files) {
  const branch = `e2e/freshness-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  freshBranch(branch);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path), { recursive: true, force: true });
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', `Freshness e2e: ${title}`);
  git('push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`);
  const hash = await hashOf();
  git('checkout', '-q', 'main');
  const file = join(dir, '.git', 'e2e-body.md');
  writeFileSync(file, `${CONTRACT}\n${verdict(hash)}\n`);
  const number = Number(gh('pr', 'create', '--title', `Freshness e2e: ${title}`, '--body-file', file, '--head', branch).split('/').pop());
  return { number, branch, hash: hash.slice(0, 12) };
}

const pull = (number) => api(`repos/${repo}/pulls/${number}`);
const gateCheck = (sha) =>
  api(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent('pipeline/gate')}&filter=all`)
    .check_runs.filter((c) => c.app?.slug === 'github-actions')
    .sort((a, b) => b.id - a.id)[0] ?? null;
const behindBy = (number) => api(`repos/${repo}/compare/main...${pull(number).head.sha}`).behind_by;
const isStale = (check) => check?.conclusion === 'failure' && /update the branch$/.test(check.output?.title ?? '') && (check.output?.summary ?? '').includes(MARKER);

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${lastError ? `; last error: ${lastError.message.split('\n')[0]}` : ''}`);
    await sleep(8000);
  }
}
// The gate's latest check on the PR's current head, once it was written after `since`.
const gateAfter = (number, since, accept, what) =>
  until(`#${number}: ${what}`, () => {
    const check = gateCheck(pull(number).head.sha);
    const written = Date.parse(check?.completed_at ?? check?.started_at ?? 0);
    return check?.status === 'completed' && written > Date.parse(since) && accept(check) ? check : null;
  });
const green = (number, since = '1970-01-01T00:00:00Z') => gateAfter(number, since, (c) => c.conclusion === 'success', 'a green gate');

// gate.yml's run for a push to main, once it finished. A PR whose freshness that
// push didn't change isn't evaluated again, so "stays green" is read after it.
const pushRunDone = (sha) =>
  until(`the gate's push run for ${sha.slice(0, 7)}`, () => {
    const done = api(`repos/${repo}/actions/workflows/gate.yml/runs?event=push&head_sha=${sha}&per_page=10`).workflow_runs.find((r) => r.status === 'completed');
    if (done && done.conclusion !== 'success') throw new Error(`the gate's push run ${done.id} ended ${done.conclusion}`);
    return done;
  });
async function staysGreen(number, merged) {
  await pushRunDone(merged.merge_commit_sha);
  const check = gateCheck(pull(number).head.sha);
  if (check?.conclusion !== 'success') throw new Error(`#${number}'s gate is ${check?.conclusion ?? 'missing'}: ${check?.output?.title ?? ''}`);
  const count = behindBy(number);
  if (!(count > 0)) throw new Error(`#${number} isn't behind main`);
  return count;
}

// Bring a PR up to date, then let GitHub merge it once the gate passes.
async function mergeNow(number) {
  run('gh', ['pr', 'update-branch', String(number)]);
  gh('pr', 'merge', String(number), '--squash', '--auto');
  return until(`#${number} to merge`, () => {
    const pr = pull(number);
    return pr.merged ? pr : null;
  });
}

// What the council does after a content change: a verdict for the new hash.
async function refreshVerdict(fix) {
  git('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${fix.branch}:refs/remotes/origin/${fix.branch}`);
  git('checkout', '-q', '--detach', `origin/${fix.branch}`);
  const hash = await hashOf();
  git('checkout', '-q', 'main');
  const body = pull(fix.number).body.replace(/<!--\s*pipeline:verdict[\s\S]*?-->/, verdict(hash));
  patch(`repos/${repo}/pulls/${fix.number}`, { body });
  return hash.slice(0, 12);
}

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

function preconditions() {
  const config = JSON.parse(fileOnMain('pipeline.config.json'));
  if (config.freshness?.mode !== 'overlap' || !config.freshness.groups?.e2e) {
    throw new Error('main\'s pipeline.config.json needs "freshness": { "mode": "overlap", "groups": { "e2e": ["e2e-group/**"] } }');
  }
  if (!/^\s+push:/m.test(fileOnMain('.github/workflows/gate.yml'))) throw new Error("main's gate.yml doesn't run on a push to main");
  git('checkout', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
}

async function cleanUp(id, open, paths) {
  for (const fix of open) run('gh', ['pr', 'close', String(fix.number), '--delete-branch']);
  const tidy = await fixture(`${id} clean up`, Object.fromEntries(paths.map((path) => [path, null])));
  await mergeNow(tidy.number);
}

// ---------------------------------------------------------------------------
// verdicts: what the gate says when main moves. Works with the up-to-date rule
// on, because the e2e only merges a PR after updating it.
// ---------------------------------------------------------------------------

async function verdicts() {
  preconditions();
  const id = Date.now().toString(36);
  const shared = `src/fresh-${id}/shared.js`;
  const seed = await fixture(`${id} seed`, { [shared]: lines() });
  await mergeNow(seed.number);

  const Y = await fixture(`${id} Y`, { [`src/fresh-${id}/y.js`]: 'y\n' });
  const Z = await fixture(`${id} Z`, { [shared]: lines({ 1: 'Z changed line 1' }) });
  const G = await fixture(`${id} G`, { [`e2e-group/${id}-g.js`]: 'g\n' });
  const W = await fixture(`${id} W`, { [`src/fresh-${id}/w.js`]: 'w\n' });
  await checkAsync('F0', 'four fixtures branched from the same main are green', async () => {
    for (const fix of [Y, Z, G, W]) await green(fix.number);
    return `#${Y.number}, #${Z.number}, #${G.number}, #${W.number}`;
  });

  // One merge that changes Z's file and a file in G's group.
  const mover = await fixture(`${id} mover`, { [shared]: lines({ 10: 'mover changed line 10' }), [`e2e-group/${id}-m.js`]: 'm\n' });
  const moved = await mergeNow(mover.number);

  await checkAsync('F1', 'behind main with no overlap stays green', async () => {
    const behind = [];
    for (const fix of [Y, W]) behind.push(await staysGreen(fix.number, moved));
    return `#${Y.number} and #${W.number} green, ${behind.join(' and ')} behind main after the push run`;
  });
  await checkAsync('F2', 'behind main with a shared file is held as "update the branch"', async () => {
    const held = await gateAfter(Z.number, moved.merged_at, isStale, 'a stale gate');
    if (!held.output.summary.includes(shared)) throw new Error('the summary does not name the shared file');
    return held.output.title;
  });
  await checkAsync('F3', 'behind main with a change in the same group is held', async () => {
    const held = await gateAfter(G.number, moved.merged_at, isStale, 'a stale gate');
    if (!/group "e2e"/.test(held.output.summary)) throw new Error('the summary does not name the group');
    return held.output.title;
  });
  await checkAsync('F4', 'an update clears a group hold, and keeps the change hash', async () => {
    const before = Date.now();
    run('gh', ['pr', 'update-branch', String(G.number)]);
    const passed = await green(G.number, new Date(before).toISOString());
    if (!passed.output.summary.includes(G.hash)) throw new Error(`the change hash moved from ${G.hash}`);
    return passed.output.title;
  });
  await checkAsync('F5', 'an update of a shared file needs a new verdict, then clears', async () => {
    const before = new Date().toISOString();
    run('gh', ['pr', 'update-branch', String(Z.number)]);
    await gateAfter(Z.number, before, (c) => /different content/.test(c.output?.summary ?? ''), 'the verdict to be void');
    const after = new Date().toISOString();
    const hash = await refreshVerdict(Z);
    return `${(await green(Z.number, after)).output.title}, change ${Z.hash} -> ${hash}`;
  });

  // A floor path: a lockfile anywhere in the tree.
  const floor = await fixture(`${id} floor`, { [`e2e-fresh-${id}/Cargo.lock`]: '# freshness e2e\n' });
  const floored = await mergeNow(floor.number);
  await checkAsync('F6', 'a floor change holds every open PR', async () => {
    for (const fix of [Y, Z, G, W]) {
      const held = await gateAfter(fix.number, floored.merged_at, isStale, 'a stale gate');
      if (!/every open PR must include/.test(held.output.summary)) throw new Error(`#${fix.number}: not held for the floor`);
    }
    return `#${Y.number}, #${Z.number}, #${G.number}, #${W.number}`;
  });
  await checkAsync('F7', 'an update clears a floor hold, and keeps the change hash', async () => {
    const before = new Date().toISOString();
    run('gh', ['pr', 'update-branch', String(Y.number)]);
    const passed = await green(Y.number, before);
    if (!passed.output.summary.includes(Y.hash)) throw new Error(`the change hash moved from ${Y.hash}`);
    return passed.output.title;
  });

  await cleanUp(id, [Y, Z, G, W], [`src/fresh-${id}`, `e2e-group/${id}-m.js`, `e2e-fresh-${id}`]);
  finish();
}

// ---------------------------------------------------------------------------
// merge-behind: only with the up-to-date rule off. A PR behind main merges
// without an update; a stale one can't.
// ---------------------------------------------------------------------------

async function mergeBehind() {
  preconditions();
  const rule = run('gh', ['api', `repos/${repo}/branches/main/protection/required_status_checks`, '--jq', '.strict']);
  if (rule.out !== 'false') throw new Error(`GitHub still requires branches to be up to date (${rule.out}). Ask the admin to turn that off first.`);
  const id = Date.now().toString(36);
  const shared = `src/behind-${id}/shared.js`;
  const seed = await fixture(`${id} seed`, { [shared]: lines() });
  await mergeNow(seed.number);
  const stale = await fixture(`${id} stale`, { [shared]: lines({ 1: 'changed line 1' }) });
  const behind = await fixture(`${id} behind`, { [`src/behind-${id}/b.js`]: 'b\n' });
  for (const fix of [stale, behind]) await green(fix.number);
  const mover = await fixture(`${id} mover`, { [shared]: lines({ 10: 'mover changed line 10' }) });
  const moved = await mergeNow(mover.number);

  await checkAsync('F8', 'a PR behind main merges without an update', async () => {
    const count = await staysGreen(behind.number, moved);
    const merged = run('gh', ['pr', 'merge', String(behind.number), '--squash']);
    if (!merged.ok) throw new Error(merged.out.split('\n')[0]);
    await until(`#${behind.number} to merge`, () => pull(behind.number).merged);
    return `${count} behind when merged`;
  });
  await checkAsync('F9', "a stale PR can't merge", async () => {
    await gateAfter(stale.number, moved.merged_at, isStale, 'a stale gate');
    const merged = run('gh', ['pr', 'merge', String(stale.number), '--squash']);
    if (merged.ok || pull(stale.number).merged) throw new Error('it merged');
    return merged.out.split('\n')[0];
  });

  await cleanUp(id, [stale, behind], [`src/behind-${id}`]);
  finish();
}

const modes = { verdicts, 'merge-behind': mergeBehind };
await modes[mode]().catch((error) => {
  console.error(`FAIL ${mode}: ${error.message}`);
  process.exitCode = 1;
});
