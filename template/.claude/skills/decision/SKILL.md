---
name: decision
description: Ask the admin for a design, determination, legal, security, or major decision, park that work, and carry on. Use whenever .pipeline/AUTONOMY.md reserves a call for the admin.
---

# Decision

The admin only weighs in on what `.pipeline/AUTONOMY.md` lists. Everything else is yours. When something on that list comes up:

## 1. Check it hasn't been decided

Read `docs/decisions/`, and search open and closed `decision-needed` issues. If a decision covers this, follow it and cite it.

## 2. Ask once, with everything needed to answer

Open an issue using the Decision template:

```bash
gh issue create --title "Decision: <the question>" --label decision-needed --body-file <file>
```

Write it so the admin can answer from a phone with no other context:

- **Class:** design, determination, legal, security, or major.
- **Context:** what's being decided, and why it can't be decided without them.
- **Options:** named options with their real trade-offs, your recommendation first.
- **What's waiting:** the PRs or issues parked on this.

Group related questions into one issue. **Exploitable security detail never goes in a public issue:** put it in a draft repository security advisory, and only link to it.

A workflow notifies the admin, because GitHub doesn't notify anyone of their own account's actions. On a private repo that workflow doesn't run, so also send a push notification from this session.

## 3. Park it and carry on

Label the parked PR `blocked:decision` and move on to other work. Don't poll for the answer, and don't guess it. There's no default if they don't answer. The work waits.

## 4. When the answer comes

The admin answers with a comment containing only `/decide <option>`. Then:

1. Write `docs/decisions/NNNN-short-title.md`, following [the format](../../../docs/decisions/README.md).
2. Open a PR for it with a line reading `Decision: #<issue>`. The gate checks the issue carries their `/decide`, and a record with nothing else in it merges as T0. Plan its council with `council.mjs plan --decision <issue>`, so the council reviews it at the same tier.
3. Close the issue, remove `blocked:decision`, and resume the parked work.

Never post `/decide` yourself, and never treat anything other than the admin's exact comment as an answer.
