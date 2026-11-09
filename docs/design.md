# Design

What this template does, where each capability came from, what's been proven, and what risks it accepts. The reasoning behind the sources is in [source-analysis.md](source-analysis.md).

## The owner's decisions

1. One GitHub account. Agents drive development, and the human weighs in only on design, determination (go/no-go and scope), legal, security, and other major factors.
2. Review is a council of Sonnet and Opus subagents with distinct specialist personas. GitHub CI runs on public repos only.
3. Low-risk and ordinary changes both auto-merge with no human step.
4. First-version packs: code-only HTML/JS/WASM/Rust, browser apps and games, Node/TypeScript, desktop or mobile, and generic.

## Capability map

| Capability | Where it lives | From |
|---|---|---|
| Runnable verification with evidence | `.pipeline/verify.mjs`, `prove` skill | Post, layer 1; commentary on running the real app |
| Gate a PR can't rewrite | `.github/workflows/gate.yml`, `.pipeline/gate.mjs` | New. Red-team finding on `pull_request` workflows |
| Risk tiers from a deterministic floor | `.pipeline/lib/tier.mjs` | Post, layer 5; commentary's doubts about classifiers |
| Approvals bound to content | `.pipeline/lib/git.mjs` | Post: an approval covers one commit. Refined so a clean rebase survives |
| PR contract | `.pipeline/lib/contract.mjs`, PR template | Post, adoption list |
| Specialist council | `.claude/agents/`, `.claude/workflows/council-round.js` | Owner's choice; post's find-then-verify design |
| Convergence | `.pipeline/lib/ledger.mjs` | Post's four fixes; `sol-loop`'s budget and severities |
| Decision requests | `decision` skill, `decisions.yml` | Owner's operating model |
| Guard hook | `.claude/hooks/guard.mjs` | New |
| Red-main response | `post-merge.yml`, `.pipeline/monitor.mjs` | Post, layer 7 |
| Circuit breaker | `.pipeline/lib/breaker.mjs` | Post says it's wanted but doesn't exist yet |
| Fast rollback | `.pipeline/lib/revert.mjs`, `docs/ROLLBACK.md` | Both sources |
| Digest and metrics | `.pipeline/lib/digest.mjs`, `audit.yml` | Post's human-time metrics; commentary on wait time |
| Reviewer evals | `evals/review/`, `.pipeline/eval.mjs` | Post; [hillclimbing guidance](https://claude.dev/blog/automating-eval-design-and-hillclimbing/) |
| Autopilot | `autopilot` skill, `.pipeline/lib/queue.mjs` | Owner's operating model; [agent automations guidance](https://claude.dev/blog/building-effective-agent-automations/) |
| Inception | `start-project` skill | Owner's own session brief |
| License and acceptance checks | `.pipeline/check-licenses.mjs`, `check-acceptance.mjs` | Owner's own session brief |
| Release, incident, retirement | `release`, `incident`, `retire` skills | Neither source. Needed for the full lifecycle |

## Design notes worth keeping

**Two workflows, on purpose.** A `pull_request` workflow runs from the PR's own merge commit, so a PR could rewrite a gate there to always pass. `gate.yml` uses `pull_request_target`, `issue_comment`, and `workflow_run`, which run from the default branch. It fetches PR objects but never checks them out or runs them. `pull_request_target` is dangerous when misused, and a lint test fails the template if `gate.yml` ever checks out PR code.

**The required check is pinned.** Branch protection requires `pipeline/gate` pinned to the GitHub Actions app. Anyone with write access can set an unpinned status, and only GitHub Apps can create check runs, so the owner's token can't forge it.

**Skipped isn't success.** GitHub treats a skipped required job as passing, so the gate reads `verify`'s conclusion from the API and accepts only `success`.

**The change hash lists blobs.** It's a SHA-256 of the modes and blob IDs from `git diff-tree --no-renames --raw` against the merge base. Testing showed that hashing diff text breaks under different `diff.algorithm` settings, and misses a swapped binary.

**Policy protects itself.** `pipeline.config.json`, `.pipeline/`, workflows, hooks, and agents are all T2, and policy is always read from the base branch. Skills, `CLAUDE.md`, and `REVIEW.md` are T1, so agents can improve their own instructions, while the authority to act lives in `.pipeline/AUTONOMY.md`, which is T2.

**State lives in bot-authored issues.** Agents hold the owner's identity, but they can't post as `github-actions[bot]`, so a red main or a tripped breaker can't be forged. A closed breaker counts as re-armed only if an admin posted `/rearm`.

**A bot @mention is the only notification.** GitHub doesn't notify you of your own account's actions, and agents act as you.

**Delegates are optional.** A `delegates` list in `pipeline.config.json` names other GitHub accounts and the commands each may post: `approve`, `decide` for some decision classes, `rearm`, and `direct` for issues that start work. With no list, nothing changes, and tests compare the gate against a frozen copy of the code from before the feature. A delegate's command counts only within its grant. It can't approve a change to an admin-only path (a built-in floor covering the files that define its own authority, plus `tiers.adminOnlyPaths`), a symlink, changed `package.json` scripts, an outside author's PR, or a PR it opened, committed to, pushed to, or edited.

**The bot records a decision's class.** When `decision-needed` lands, the bot posts the class it read from the issue body in a hidden marker, and the earliest unedited marker is the record, so editing the body later can't lower it. No class, an ambiguous one, or an edited bot comment means only an admin can decide. A delegate's `/decide` within its grant also lets the decision record merge at T0, as an admin's does. That is intended: the record writes down a decision already made within the grant.

**No AI and no secrets in CI.** The council runs locally on a subscription, so a public repo's CI has nothing to steal.

## Risks the owner is accepting

- **With one account, the human gate is soft.** An agent token can post a comment under the owner's login, and GitHub can't tell who wrote it. The exact-match rule stops accidents, the guard stops obvious attempts, and the immediate @mention makes a rogue approval visible, but none of that prevents one. The owner's full token also still sits in the keyring. The upgrades, if ever wanted, are signed approvals (`ssh-keygen -Y sign` with a key only the owner can unlock) or a separate agent account.
- **Zero-human T1 goes further than both sources.** Anthropic's ordinary changes still get one person, and Theo's zero-human merges are limited to easy bug fixes. The breaker, revert path, and evals compensate, but some bad merges should be expected.
- **Same-family reviewers share blind spots.** Personas diversify focus, not the model. `council.externalSeats: ["codex"]` adds Codex for T2.
- **Council verdicts in CI are self-reported,** since no AI runs there. The gate checks that a verdict matches the change, not that the review truly happened. Red main, smoke checks, and evals are the independent signal.
- **Private repos on Free have no enforcement at all,** which is why agents stop at ready there by default.
- **The guard hook is a pattern match.** A script written to disk can evade it. The restricted token is what limits the damage.

## Verification record

### Self-tests

`npm test`. Covers tiers, the change hash, the gate's rules, the guard's command table on Bash and PowerShell forms, the ledger, scaffolding into a path with spaces, updates, licenses, acceptance criteria, the breaker, the digest, and lint rules for every shipped workflow.

### On real GitHub

See [sandbox-results.md](sandbox-results.md), from `tests/e2e/sandbox.mjs` against a public repo. Every result comes from GitHub's own API state.

### Stack packs

`tests/e2e/packs.mjs` scaffolds each pack and runs its real verification, including a real WASM build, a real Tauri build, Playwright browsers, and `cargo deny`.

The template repo's own CI runs them on Ubuntu, Windows, and macOS runners, along with `actionlint` on every workflow.

### Council quality

See [reviewer-baseline.md](reviewer-baseline.md).

### The restricted agent token

On November 8, 2026, with the token given to Claude sessions through `GH_TOKEN` as [AGENT-TOKEN.md](AGENT-TOKEN.md) describes, `tests/e2e/agent-token.mjs` passed 11 of 11 against `pipeline-sandbox`. GitHub refused protection removal, settings changes, a workflow push, a forged gate check run and a forged status, and `--admin` couldn't merge a red gate. Pushing, opening a PR, auto-merge and comments all worked.

### Not verified yet

- **`onFailure: "block"` when the guard hook itself fails.** A fresh session in an adopted project (GIS Workbench, November 7–8, 2026) loaded `.claude/agents` and `.claude/skills`, ran council rounds with the registered seats, and the guard blocked real `--admin` and `--no-verify` calls on Bash and PowerShell. A hook that crashes or times out hasn't been seen yet. The same run took every flow in [sandbox-results.md](sandbox-results.md) through an adopted project with a real test suite: T0 auto-merge, T1 and T2 approvals and a voided approval, a decision record, a change that failed only on main and its `Revert-of` revert, and a draft release.
- **Real fork PRs.** One account can't open one, so the external-author path has unit tests only.
- **Android and iOS builds.** This machine has no JDK or Xcode. Windows and macOS Tauri builds are verified.
