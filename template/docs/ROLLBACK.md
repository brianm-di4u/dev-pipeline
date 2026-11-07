# Rolling back

The fastest safe path back to a working main comes first. Don't debug on a broken main: revert, then fix on a branch.

## Revert a merged change

1. Find the squash commit on main.
2. Create a branch and run `git revert --no-edit <commit>`.
3. Open a PR whose body contains this line:

   ```text
   Revert-of: <commit>
   ```

The gate verifies the diff is the exact inverse of that commit. If it is, the PR skips review and merges as soon as `verify` passes. There's no shortcut if the original touched a protected path or was itself a revert.

## Fix forward instead

When a revert isn't possible, open a PR that fixes the problem and include this line, which lets it merge while main is red:

```text
Fixes-main-red: #<issue>
```

## What a revert won't undo

<!-- List anything specific to this project: data migrations, published packages, sent email, store releases. -->

## Releases

<!-- How to roll back a release in this project: flags, pinned versions, a previous tag, or a store rollout halt. -->
