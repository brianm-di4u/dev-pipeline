---
name: incident
description: Respond to something broken in production or on main, then make sure it can't recur the same way. Use when main is red after a real failure, a smoke check fails, a user reports breakage, or a release goes bad.
---

# Incident

## 1. Stop the bleeding

Restore service first and debug afterward. Turn off the flag or revert, per [docs/ROLLBACK.md](../../../docs/ROLLBACK.md). You land it, you own it, and that isn't blame: it means you have the most context.

Ask the admin only if data, money, or legal exposure is involved. Use the `decision` skill, and put exploitable detail in a draft security advisory.

## 2. Fix the cause

Reproduce it first. Then fix it on a branch through the normal flow.

## 3. Write it up

Copy [docs/incidents/TEMPLATE.md](../../../docs/incidents/TEMPLATE.md) to `docs/incidents/YYYY-MM-DD-short-title.md`. Look at the system, not at people. The question that matters: **which layer should have caught this, and why didn't it?**

## 4. Make it stick

Fix it at the highest rung that can hold it:

1. **The code:** make the mistake hard to make.
2. **A check:** a lint rule, a type, or a test.
3. **A hook.**
4. **A skill or instruction,** only when nothing above can hold it.

Then add a case to `evals/review/cases/` built from the real PR, so the reviewer gets scored on catching it. See the `reviewer-eval` skill.
