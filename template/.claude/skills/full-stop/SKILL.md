---
name: full-stop
description: Do everything full-send does, but stop with the PR ready and unmerged. Use when asked to full stop, or to leave a PR ready for the admin.
---

# Full Stop

Follow the [full-send](../full-send/SKILL.md) skill, with these changes.

## No merging

You may commit, push, rebase, fix conflicts, and use `--force-with-lease` on this task's branch. Never merge, enable auto-merge, or push to the default branch. If auto-merge is already on, turn it off with `gh pr merge --disable-auto <n>` and report that you did.

## Stop at the gate

Replace the merge and final report steps with a handoff. Check the live PR's head, checks, and mergeability, and confirm it's open and not set to merge without the admin. Then report one of these:

- **Ready to merge:** the gate passes. The PR stays open and unmerged.
- **Waiting for approval:** only a human approval remains. Give the exact comment to post.
- **Blocked:** what prevents readiness, what you tried, and what's needed.

Include the PR link, final head, proof, council outcome, and remaining risks.
