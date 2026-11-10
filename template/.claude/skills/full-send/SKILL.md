---
name: full-send
description: Take a change all the way to a merged PR with nobody watching. The default way to ship a change in this repo. Use when asked to full send, ship, or finish a change.
---

# Full Send

You own this change from its current state to a merged PR. Nobody's watching, and your updates go unread until long after you stop.

## Steps

1. **Finish the change** with the smallest thing that works. Fix the case that happened, not every case that could. Work on a branch, never on `main`.
2. **Prove it** with the `prove` skill, for every change you made.
3. **Review it** with the `council` skill until it says `done`. If it says `parked`, leave the PR open with a summary and report it.
4. **File the PR** with the `file-pr` skill, after rebasing onto the latest `main`, with the verdict block in the body.
5. **Merge when the gate allows it.** On a public repo, check first that the branch doesn't need an update from `main`. It exits 1 if it does: update from `main`, push, and babysit again before merging.

   ```bash
   node .pipeline/gate.mjs fresh
   gh pr merge <n> --auto --squash
   ```

   On a private repo, run `node .pipeline/gate.mjs local --evidence`, and then stop and report the PR as ready. Merging there is the admin's, unless `privateAutoMerge` is set in `pipeline.config.json`.
6. **Babysit** with the `babysit-pr` skill until it merges. Prove each fix before pushing it. If the verdict is voided, run the council again.
7. **Check main** after the merge. If main goes red, reverting or fixing it comes before anything else. See [docs/ROLLBACK.md](../../../docs/ROLLBACK.md).
8. **Report:** the PR link, the merge commit, your proof, and each decision you made.

Stay active from step 1 to step 8. If you end your turn while checks are pending, the work stops, because nobody will prompt you again. Wait with the watcher.

## The gate decides

`pipeline/gate` decides whether this merges, and you can't overrule it. If the tier is T2, it's waiting for a human: open a decision request with the `decision` skill if there isn't one, and move on to other work. Never use `--admin`, and never ask anyone to loosen a check so that something can merge.

## Asking

Ask the admin only about what `.pipeline/AUTONOMY.md` reserves for them: design, determination, legal, security, and major decisions. Use the `decision` skill, which parks that work and lets you carry on.

Decide everything else yourself, using sensible defaults, and list those decisions in your report. If you can't prove a change or a merge can't pass, leave the PR open and say exactly why.
