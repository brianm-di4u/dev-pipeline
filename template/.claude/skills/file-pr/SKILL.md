---
name: file-pr
description: File a short pull request that leads with the problem. Use when asked to file, open, or create a PR, or as part of full-send and full-stop.
---

# File PR

Before filing, check whether a PR for this branch already exists. Review the diff against `origin/main` to make sure it matches the goal.

## Title

PR titles become commit messages, so follow the repo's conventions. Prefer a concise, human-readable title that says why the change matters:

> ❌ perf(server): negotiate permessage-deflate on the websocket

> ✅ perf(server): cut websocket frame size by 70%+ with compression

## Description

Open with the problem in plain words, based on the original request. Then briefly explain the solution. Don't lead with an inventory of changes:

> ❌ Removed implicit workspace carry-over from every "new thread" entry point. Deleted buildContextualThreadOptions and the seed-context machinery.

> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Now your preferences always apply.

Then fill in the three required sections. The gate blocks the PR without them:

```markdown
## Testing
What you ran and what it returned.

## Risk
What could go wrong, who it would affect, and what the checks wouldn't catch.

## How to revert
Usually: revert this squash commit. Call out anything a revert won't undo.
```

End with the council verdict block from `node .pipeline/council.mjs verdict`, then one line naming who made the change: `Created with <model> in <harness>.` Use the name the harness reports, and don't guess.

Special cases, each as a line of its own in the body:

- **Decision record:** `Decision: #<issue>`
- **Fix for a red main:** `Fixes-main-red: #<issue>`
- **Clean revert:** `Revert-of: <commit>`. This needs no other sections. See [docs/ROLLBACK.md](../../../docs/ROLLBACK.md).

## Before you submit

Check the title, description, and attachments for secrets and private details. Open a real PR rather than a draft, because the gate blocks drafts.

Updating the body later is fine and doesn't re-run `verify`. Use `leaving-pr-comments` for any comment.
