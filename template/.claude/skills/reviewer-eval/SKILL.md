---
name: reviewer-eval
description: Score the council against known bugs and known-clean changes. Use when seat prompts, tools, or models change, when an incident adds a case, or when asked how good the reviewer is.
---

# Reviewer Eval

Anything you can't measure, you can't fix. This scores the council on planted bugs, real incidents, and clean changes that should draw no blocking findings. It spends subscription tokens, so run it when something changed or weekly, not on every PR.

## Run it

1. Prepare the cases. Use `--split train` while working on a prompt, and keep `--split test` as the holdout:

   ```bash
   node .pipeline/eval.mjs prepare <temp-dir> --split train
   ```

2. Call the Workflow tool with `scriptPath: ".claude/workflows/reviewer-eval.js"`, passing `{ "plans": <contents of plans.json>, "roundScript": "<absolute path to .claude/workflows/council-round.js>" }` as `args`. Save what it returns as a JSON file.

3. Grade it:

   ```bash
   node .pipeline/eval.mjs grade <temp-dir> <results.json>
   ```

Never read `evals/review/_starter/cases.mjs` or `evals/review/cases/` while reviewing, and never give them to a seat. They hold the answers.

## Improving the reviewer

Change one thing at a time, aimed at the root cause of a failure. Keep a change only if both train and test improve. If train goes up and test stays flat, you're overfitting, so revert it. Don't paste failing case content into prompts.

If the score stalls for two or three rounds, stop editing and sort the remaining failures by cause. A broken case or grader gets fixed or removed, not optimized against.

Report the numbers honestly, including weak ones, and keep the last baseline in `docs/reviewer-baseline.md`.

Seat prompts are a protected path, so a change to them needs the admin's approval. Put the before and after scores in that PR.

## Adding a case

After an incident, add `evals/review/cases/<id>.json`, with the same shape as the starter cases: `id`, `split`, `kind`, `intent`, `base`, `head`, and `expect` with `file`, `from`, `to`, and `words`. Have someone who knows that code confirm where the bug lived. Put every third case in `test`.
