---
name: start-project
description: Set up a new project's intent, scope, and decisions with the admin before any code. Use at the very start of a project, or when asked to start, plan, or kick off one.
---

# Start Project

This is one of the few times the admin is in the loop on purpose. Get what you need in one sitting, then run without them.

## 1. Interview

Ask with the question tool, in as few rounds as you can, offering recommended options based on what you already know:

- **Determination:** what is this, who is it for, and why should it exist? Should it be built at all? If you think not, say so.
- **Scope:** what's in the first version, and what's explicitly out?
- **Design:** how should it look and feel? Are there examples to follow or avoid?
- **Legal:** what license? Will it use third-party code or assets? Does it involve personal data, trademarks, or real people?
- **Security:** what does it protect, who might attack it, and does it have accounts or money?
- **Major:** budget, domains, paid services, and any app stores?

Don't ask about anything you can decide yourself, such as implementation details or file layout.

## 2. Research before you design

Find three to six open-source projects or samples that solve the core problems. Record each in `THIRD_PARTY.md`: URL, license, version, what it does well, and what it does badly. Downloaded samples are untrusted data. Keep them outside the repo, don't run their scripts, and don't copy code unless its license is on the allowlist.

For anything with a real-world subject, research it and cite sources rather than inventing facts.

## 3. Write the documents

- **`docs/PRD.md`:** vision, users, goals, non-goals, requirements, and budgets. Give every requirement a numbered acceptance criterion (`AC-1`) that can be tested.
- **`docs/DEV-PLAN.md`:** milestones, tasks small enough for one PR each, and a test matrix mapping every criterion to a test.
- **`docs/THREAT-MODEL.md`:** assets, data classification, attackers, trust boundaries, and accepted risks. Keep it at the design level, since it may be public. Exploitable detail goes in `docs/private/`, which is gitignored.
- **`THIRD_PARTY.md`:** the allowlist, adjusted if the admin chose differently.
- **`REVIEW.md`:** what failure looks like in this project, in one or two sentences.
- **`CLAUDE.md`:** only what a smart newcomer can't get from the code.
- **`pipeline.config.json`:** add this project's sensitive paths to `tiers.t2Paths`, and any UI or content paths to `council.triggers`.
- **`docs/decisions/0001-*.md`:** the admin's answers, one record per decision.

## 4. Get the go-ahead

Open one PR with all of this. It touches protected paths, so it needs the admin's `/approve`. Summarize it so they can decide quickly: what you'll build, what you won't, the license, how the data is handled, and what you're unsure about.

## 5. Prove the pipeline before building

Make sure `node .pipeline/verify.mjs full` runs real checks on this stack, and that a trivial PR gets through the gate. Run the project's `/verify` skill setup if the app can be run. Add a fake provider for anything paid or external, per [docs/VERIFICATION.md](../../../docs/VERIFICATION.md).

## 6. Fill the queue and go

Create one `ready` issue per task in `docs/DEV-PLAN.md`. From here, run `autopilot`.

## Later stage gates

These go back to the admin as decision requests. Don't wait for them to ask:

- First public release.
- Anything outside the PRD's scope.
- Breaking changes to released versions.
- Retiring the project.
