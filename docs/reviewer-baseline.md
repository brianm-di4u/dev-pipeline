# Reviewer baseline

How the council scored on its starter evals, on November 7, 2026. Rerun with the `reviewer-eval` skill whenever seat prompts, tools, or models change, and compare against this.

## Result

| Set | Bugs found | Clean changes with no blocking false alarm |
|---|---|---|
| Starter, planted bugs and clean changes | 14 of 14 | 4 of 4 |
| Harder cases (`hard: true`) | 7 of 7 | 3 of 3 |
| **Total** | **21 of 21** | **7 of 7** |

Train and holdout scored the same.

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
- **Verification rarely refuted anything:** 1 of 69 surviving-or-refuted findings across both runs. Small planted cases give seats little room to be wrong, so this doesn't yet show the panel is earning its cost. Watch the `wrong` disposition in the digest on real PRs.
- **Beyond the plant:** the council also found real problems no case was built around, such as cache entries never being invalidated, and a truncating `Math.floor` in a fix that claimed to round.

## Cost

A T1 round, with 5 seats and 2 voters, used about 430,000 subagent tokens, or 60,000 per agent, and took about a minute. Most of that is each agent's starting context rather than review work. The 28 cases together used about 11.4 million tokens on the subscription, and the weekly usage meter moved little on the Ultra plan.

To spend less per PR, lower `council.maxSeats` in `pipeline.config.json`.
