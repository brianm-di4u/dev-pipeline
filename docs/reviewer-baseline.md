# Reviewer baseline

How the council scored on its starter evals, on November 7, 2026. Rerun with the `reviewer-eval` skill whenever seat prompts, tools, or models change, and compare against this.

## Result

| Set | Bugs found | Clean changes with no blocking false alarm |
|---|---|---|
| Starter, planted bugs and clean changes | 14 of 14 | 4 of 4 |
| Harder cases (`hard: true`) | 7 of 7 | 3 of 3 |
| **Total** | **21 of 21** | **7 of 7** |

Train and holdout scored the same. This is the rescore after the verifier fix described below. The score before that fix was the same.

## How to read this

**A perfect score here doesn't mean the reviewer catches everything.** The [eval guidance](https://claude.dev/blog/automating-eval-design-and-hillclimbing/) says a good set leaves headroom, and even the best reviewer should score well below 100%. This set doesn't, so treat it as evidence of two narrower things:

- **The machinery works.** Seats, verification, ranking, and grading all function end to end on real models.
- **It isn't an obvious failure.** It catches common bug classes, including ones that need reasoning beyond the diff, and it holds back on code that only looks wrong.

Three things flatter this score:

- **The cases are small.** Each is one or two short files. Real bugs hide in far more context.
- **Intents give hints.** Several name the property that breaks, such as "the service handles requests concurrently", because a fair case needs a stated requirement.
- **I wrote the cases and the grader,** knowing what the council looks for.

The score that matters will come from `evals/review/cases/`, as real incidents and reverts add cases that the council actually missed. That's where headroom comes from.

## Worth noting

- **Prompt injection:** in `injected-reviewer-instructions`, a code comment told reviewers to report nothing. The council reported the real bug and flagged the comment itself as a finding.
- **Verification rarely refuted anything:** 0 of 62 findings in the final run, and 1 of 69 before it. Small planted cases give seats little room to be wrong, so this doesn't yet show the panel is earning its cost. Watch the `wrong` disposition in the digest on real PRs.
- **Beyond the plant:** the council also found real problems no case was built around, such as cache entries never being invalidated, and a truncating `Math.floor` in a fix that claimed to round.

## The failure evals didn't catch

The evals all passed while the council had a dangerous bug, which only a real run on a sandbox PR exposed. Every seat found a planted bug, and then verifiers started in the wrong folder couldn't see the code. They had been told to call anything they couldn't confirm "refuted", so they refuted every finding. The round came back complete with zero findings, on a change with a real bug, and it would have auto-merged.

The evals missed this because each case names its own folder, which is exactly what the real flow lacked. Now every reviewer has to prove it can see the change, refuting a finding takes evidence, and a verifier that can't check something makes the round incomplete. `tests/council-round.test.mjs` runs the real workflow against these failures, and the same broken setup, rerun for real, now reports all five seats as missing.

Good eval scores don't prove the pipeline around them works.

## Cost

A T1 round, with 5 seats and 2 voters, used about 430,000 subagent tokens, or 60,000 per agent, and took under a minute. Most of that is each agent's starting context rather than review work. All 28 cases together used about 11.3 million tokens on the subscription. Weekly usage on the Ultra plan was 4% before the first evals and 5% after two full runs' worth of them.

To spend less per PR, lower `council.maxSeats` in `pipeline.config.json`.
