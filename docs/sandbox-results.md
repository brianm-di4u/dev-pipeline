# Sandbox results

These results come from `tests/e2e/sandbox.mjs` running against [brianm-di4u/pipeline-sandbox](https://github.com/brianm-di4u/pipeline-sandbox), a real public repo on the GitHub Free plan, using the gate as shipped. Every result is read from GitHub's own API state, not from what an agent reported. Last run: November 7, 2026.

## Attacks: all of these had to fail to merge

| ID | Attack | Result |
|---|---|---|
| A1 | A PR rewrites `gate.yml` and `ci.yml` to always pass | The gate ran from main anyway: T2, waiting for approval. Merge refused |
| A2 | A PR sets T2 to auto in `pipeline.config.json` and empties the protected paths | T2, blocked. Policy is read from the base branch |
| A3a | A workflow is moved into `docs/` | T2, blocked. Both ends of the move are seen |
| A3b | A `.Claude/Settings.json` case variant with `bypassPermissions` | T2, waiting for approval |
| A4a | A whitespace-only change after a verdict | Verdict voided |
| A4b | A swapped binary after a verdict | Verdict voided |
| A5a | A failing `verify` | Blocked |
| A5b | `verify` skipped with `if: false`, plus a valid approval | Blocked. Skipped isn't success |
| A6 | Forging the gate with the owner's token | Check run refused. A commit status posted fine and was ignored, because the required check is pinned to GitHub Actions |
| A7a | Comments that quote `/approve <hash>` | Still waiting |
| A7b | A comment edited into `/approve <hash>` | Still waiting |
| A8 | A direct push to main with the owner's token | Refused by the server |
| A9 | `gh pr merge --admin` on a red gate, with the owner's token | Refused |
| E6 | A "revert" with extra content | No fast path: blocked |

## Normal flow: all of these had to work

| ID | Scenario | Result |
|---|---|---|
| E1 | A docs PR | T0, auto-merged with no human |
| E2 | An ordinary change with a clean verdict | T1, auto-merged with no human |
| E3 | A protected change | Waited, `/approve` opened it, a new commit voided it, a re-approval merged it. The approval produced a bot notice |
| E4 | A clean rebase | The verdict survived |
| E5 | A bad merge | Reverted through the fast path, and back on main in 53 seconds |
| S0 | A template update | Landed as a T2 PR with an approval |
| D1 | A decision request | The owner was notified by a bot @mention. A quoted `/decide` did nothing, and an exact one labeled the issue. The record merged as T0 when it cited the decision, and was T2 when it didn't |
| D2 | A GPL dependency | Blocked, naming the package and asking for a legal decision. Other work carried on and merged |
| M1 | A change that fails only on main | Opened a bot issue that notified the owner, blocked T1 merges, a clean revert merged, and the issue closed itself |
| B1 | Repeated failures | The breaker tripped and T1 stopped auto-merging. Closing its issue changed nothing, and `/rearm` cleared it |
| U1 | Weakening protection | The audit opened an issue, and closed it after the repair. The digest was posted |
| P1 | The repo made private | `doctor` reported advisory, CI stayed off, the local gate blocked and then passed correctly, and the pre-push hook blocked main |

## What this doesn't cover

- **Real fork PRs.** There's only one account, so external authors are covered by unit tests only.
- **The agent token's limits.** `tests/e2e/agent-token.mjs` tests them, but it needs the restricted token, which only the owner can create. See [AGENT-TOKEN.md](AGENT-TOKEN.md).
- **The guard hook inside a live Claude Code session.** It's tested by running the hook itself on a table of commands, and the settings file is checked. See the open item in [design.md](design.md).

## Bugs these runs found

Running against real GitHub found things unit tests couldn't:

- **A deadlock.** A failed approval notice overwrote a passing check with a failure, because the workflow token lacked permission to comment on PRs. The gate now keeps its decision, and the notice has the right permission. `pipeline protect --off` was added as a break-glass after this.
- **`node --test tests/` behaves differently across Node versions.** The packs now pass a glob.
- **Git Bash rewrites a leading slash** in arguments, turning `/approve` into a path. That's harmless for the gate, but it's why tests post comments as JSON.
- **GitHub refuses a visibility change while the previous one is settling.** The test now retries.
