---
name: modernize
description: Get an old PR up to date, and decide whether it should still exist. Use when asked to rebase a PR or "modernize".
---

# Modernize

Modernize the idea, not just the branch. A clean rebase doesn't prove that the PR still belongs in the product.

## Guardrails

- Pull the latest origin for your branch, main, and any related branch before starting.
- Treat existing worktree changes as someone else's. Use a disposable worktree when the active one is dirty or in use.
- Modernizing authorizes rebasing and updating the PR branch. It doesn't authorize merging, closing, changing the base branch, or expanding scope.
- Never use an unqualified force push. Update a rebased branch with `--force-with-lease` against the head SHA you saw before the rebase.
- Never check out an external PR. Review those by API diff, and report a recommendation only.
- Don't post a PR comment unless asked. Use `leaving-pr-comments` for any you do post.

## Establish the PR's intent

Resolve the PR and record its URL, state, base, head, author, checks, and review state. Read the title, body, linked issues, commits, review threads, and complete diff. State the smallest coherent goal it was trying to accomplish before judging how it did so.

Fetch the latest base and PR head, and record the merge base, so the original PR and later base-branch changes can be compared separately.

## Check what changed around it

Inspect commits added to the base branch since the PR diverged. Search merged and open PRs for a replacement or competing implementation. Look beyond overlapping lines:

- Has the same user-facing problem already been solved?
- Did APIs, types, schemas, dependencies, or boundaries change?
- Do both sides now claim ownership of the same behavior?
- Was the code being changed deleted, moved, or simplified?
- Would landing it restore an old behavior, or create two ways to do the same thing?
- Is the original benefit still worth the maintenance cost?

Don't call a PR current merely because Git reports no conflicts.

## Choose a disposition before pushing

- **MODERNIZE:** the goal is still useful and the implementation is still the right shape. Rebase, resolve conflicts, test, and update the branch.
- **REWORK:** the goal is still useful, but a mechanical rebase would preserve the wrong implementation. Explain the smallest credible rewrite, and stop before pushing unless you were also asked for the rework.
- **CLOSE:** the PR is superseded, obsolete, directionally wrong, or no longer worth its cost. Cite concrete evidence and stop. Closing your own agent PR with a stated reason is fine. Ask before closing anyone else's.

Be willing to recommend CLOSE. Age alone isn't evidence, and sunk effort is no reason to keep a PR alive.

## Rebase without losing intent

1. Create a safe local branch or disposable worktree at the recorded head.
2. Rebase onto the freshly fetched base.
3. Resolve each conflict according to the PR's intent and the base's newer invariants. If a conflict reveals a product or architecture disagreement, stop and reconsider the disposition.
4. Compare the series before and after with `git range-diff`, and inspect the final diff. Confirm that no intended behavior disappeared and nothing already landed was reintroduced.
5. Run `node .pipeline/verify.mjs fast`. Tell real failures apart from pre-existing or infrastructure ones.
6. Push with `--force-with-lease`. If the lease fails, fetch and reassess rather than overwriting new work.

A conflict resolution changes the change hash, so the council verdict is void. Run `council` again before it can merge.

## Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and the reason. Then summarize the meaningful base changes, conceptual conflicts, the rebase and push result, checks and their results, and the remaining decision, with a link to the PR. Separate observed facts from judgment, and say what you couldn't verify.
