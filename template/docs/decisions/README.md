# Decisions

One file per decision, numbered in order: `0001-short-title.md`. Agents check here before asking the admin anything, so a question is only ever asked once.

```markdown
# 0002: Short title

- **Date:** YYYY-MM-DD
- **Class:** design | determination | legal | security | major
- **Issue:** #123
- **Status:** accepted | superseded by 000N

## Context

What had to be decided and why.

## Decision

What the admin chose.

## Consequences

What this makes easier, harder, or off-limits.
```

Open the PR with a line reading `Decision: #123`. The gate checks that the issue carries the admin's `/decide`.
