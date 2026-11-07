# Source analysis

This template draws on three sources:

- **The post:** [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/) by Addy Osmani, Morgan Westlee Lunt, and Qing Wang (Oct 15, 2026).
- **The commentary:** a 42-minute video in which Theo Browne reads the post and responds to it. The transcript is kept out of this repository because it is someone else's copyrighted content. Everything here is paraphrase.
- **The skills:** [tstack](https://github.com/t3dotgg/tstack) (MIT), reviewed at commit `1085050f3bae`.

## What the post describes

The Claude Code team kept review but moved most of the reading to machines. From June to September, merged PRs more than doubled while the share that had to be reverted fell by more than 40%. Their goal is that most PRs merge with at most one human in the loop, who can be the author, with no rise in reverts or incidents. They track approvals per PR (median and p95), human comments, and how long a PR waits on a person, with revert and incident rates as the guardrail.

A change passes through seven layers:

1. **Verification before anyone looks.** Claude runs tests or a build and shows the output, then a fresh-context subagent reviews the diff.
2. **AI review on every PR.** Parallel agents hunt for bugs, a separate group votes on each finding, and style-only findings are dropped. Findings are tagged Important, Nit, or Pre-existing, and each must be answered.
3. **Security review** that can block.
4. **Automated checks** that block: lint, types, cross-platform tests, build.
5. **Human approval scaled by risk.** Low needs nobody once automated checks pass, medium needs one person, high needs two. The change sets the tier, not the author. An agent's approval never fills a human slot, and an approval covers one specific commit.
6. **Merge queue, flags, and gradual release.**
7. **Fast detection and rollback.** The post says they don't yet have circuit breakers that tighten approval when reverts rise, and that engineers want them before more code moves to zero-human merges.

The post also explains how they improve the reviewer:

- **Incidents become evals.** Confirmed incident PRs form an eval set the reviewer runs against daily.
- **Noise is measured.** Comments are sorted by how the author responded, and the reviewer also runs on known-clean PRs.
- **Convergence is enforced.** One PR went through more than fifty overnight rounds. About 59% of what the reviewer kept flagging was code that had been there since its first pass. The fixes were a round cap with a step-back after three, diff-only re-review, flagging the class of bug, and no repeated findings.

Humans stay responsible for whether to build something, risky code, architecture others will copy, reading the evidence, and owning the outcome. Understanding spreads through explainers written on demand and open channels rather than through reading every diff.

## What the commentary adds

Theo mostly agrees, and adds these points from running T3 Code:

- **Verification should mean running the thing.** He has agents launch the app, record it working, and use fake model providers so end-to-end tests burn no tokens.
- **Review before the PR should be universal,** not most of the time.
- **Layers can add as well as remove.** A 50-line PR can bloat to thousands of lines as an agent answers every finding from every layer.
- **Human energy is distinct from time,** and waiting between people is often the biggest cost.
- **Agents, not humans, should triage review-bot output.** A human should see a finding only after an agent has judged it.
- **Runaway loops are real.** One of his council runs went four days and reached about 80,000 lines.
- **Fix the code before writing prose.** Citing a colleague, he argues for correcting the codebase first, then static checks, and reaching for instruction files and skills only after both fail. He notes his own `AGENTS.md` changes because the repo changed, not because an agent erred.

## Where both agree

These are adopted as written:

- Agents show evidence before anyone reviews.
- Review happens before the PR exists.
- Defense comes in layers with fast rollback beneath them.
- Human attention is the scarce resource, and it gets measured.
- Review loops must converge.
- A bot's approval never equals a human's, and whoever prompted the change owns it.
- The change sets the risk, not the author.
- PR templates cover testing, risk, and how to revert.
- Incidents become evals.
- An explainer for the code you're about to touch beats reading trivial diffs.
- Closing a PR is cheap.

## Where they conflict

| Question | Post | Commentary | Decision here | Why |
|---|---|---|---|---|
| Where a repeated finding gets fixed | Skill, lint rule, or instruction file | Code, then static checks, then skills and prose | The commentary's ladder, with a hook rung added | A check can't be ignored; an instruction can |
| Reviewer | Managed Code Review | Too expensive; a council on a real machine that can run the code | A local persona council | The [docs](https://code.claude.com/docs/en/code-review) confirm the service needs Team or Enterprise, bills by token, never blocks, and doesn't run code |
| When review is done | Round cap and re-review rules | A 1 to 10 score; a colleague at Graphite counters with a boolean | Per-finding severity plus the round cap | Counting comments or averaging scores hides the one finding that matters |
| Risk tiers | A classifier picks 0, 1, or 2 approvals | Dislikes fixed tiers; friends at Cursor call tiering a losing battle | A deterministic path floor; AI may only raise it | A prompt can't talk a path floor down |
| Autonomy | One person on ordinary changes | Zero-human so far only for easy bug fixes; `full-send` may ignore a request for human review | Zero-human ordinary changes, by the owner's explicit choice | **This goes further than both sources**, so it adds a circuit breaker and removes the override |
| Merge queue | Yes | Probably needed, but he'd avoid it as long as he can | Strict up-to-date checks | [Queues need an org-owned repo](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) |

## Handle with care

- "They can't use Git and GitHub anymore" is Theo's claim. The post doesn't say it.
- Theo rounds some figures, such as 60% where the post says 59%.
- The Browserbase segment is a paid ad.
- His case for multi-provider review rests on his experience. Neither source has data on it. This template's council uses one model family by the owner's choice, and that's listed as an accepted risk in [design.md](design.md).

## What neither source covers

Both focus on the path from a change to production. A pipeline for a whole project lifecycle also needs inception and scope, legal and licensing, threat modeling, supply chain, prompt injection against agents, agent cost limits, release mechanics, operations, and retirement.

The owner's own process for the Hot Springs Games collection already solves several of these: numbered acceptance criteria, a test matrix mapping each criterion to a test, a license allowlist, handling of downloaded samples as untrusted data, visual inspection of every screenshot, and close-out reports. The template absorbs those patterns.

## The tstack skills

| Skill | Verdict | Finding |
|---|---|---|
| `file-pr` | Adopted | Good problem-first PR style. Lacks testing, risk, and revert sections |
| `leaving-pr-comments` | Adopted | Marks agent comments clearly, which matters more with one shared account |
| `sol-loop` | Merged into `council` | The best convergence rules of the set: a 3-round budget, a ledger, and severity defined by the intended case. Tied to one model |
| `council` | Rewritten | Has **no round cap** and loops until every delegate is satisfied, the same shape as the runaway Theo describes. Needs three providers |
| `full-send` | Adapted | Permits ignoring automated "needs human review" requests, and overrides project rules on testing. Both removed |
| `full-stop` | Adapted | Follows `full-send`, stops before merge |
| `babysit-pr` + `pr-wait` | Patched | `pr-wait` imports `fcntl`, so it fails at import on Windows. It also ignores comments from the viewer's own login and hard-codes two commercial review bots |
| `modernize`, `takeover` | Adopted | Sound as written, minus T3 Code references |
