---
name: council
description: Review the current branch with the persona council, in rounds that always end. Use before filing a PR, when asked for a council, or as part of full-send and full-stop.
---

# Council

A council of specialist Sonnet and Opus reviewers. A deterministic ledger decides how many rounds a change gets, so review can't run away. Your job is to answer real findings with the smallest fix, and to fight scope creep.

## Before you start

Fix what you already know about. Commit everything, because the council reviews commits. Run `node .pipeline/verify.mjs full`, so that evidence exists for this exact change.

## The loop

Run this and follow its `status`:

```bash
node .pipeline/council.mjs plan --intent "what this change is for" --out-of-scope "what it deliberately doesn't do"
```

| `status` | What to do |
|---|---|
| `commit-first`, `prove-first`, `needs-intent` | Do what `message` says, then plan again. |
| `review` | Run a round (below). |
| `answer-findings` | Answer each finding (below). |
| `cut-first` | The diff grew during review. Cut what the intent doesn't need. If the growth is justified, run `council.mjs accept-growth "reason"`. |
| `step-back` | The budget is spent. Don't patch further. Reconsider the approach, redo it if needed, run `council.mjs step-back`, verify, and plan again. |
| `parked` | Stop. Leave the PR open with a short summary of both sides, and move on. This isn't approval. |
| `done` | Run `node .pipeline/council.mjs verdict` and put the block it prints at the end of the PR body. |

## Running a round

Save the `plan` JSON, then call the Workflow tool with `scriptPath: ".claude/workflows/council-round.js"` and pass the plan as `args`. Save what it returns to a file, then record it:

```bash
node .pipeline/council.mjs record <result.json>
```

If the seats aren't registered in this session, which shows up as an unknown agent type, plan again with `--inline-personas`. It passes the same prompts and models inline.

If the Workflow tool isn't available, do the same thing by hand, and run every agent in `isolation: "worktree"` with `Edit` and `Write` unavailable:

1. Start each agent in `plan.seats` with the Agent tool, all in one message, using its `model` override if it has one. Give each seat the same brief `council-round.js` builds. A `mode: "confirm"` plan has no seats: give the brief to one `council-verifier` and ask only what the last fix got wrong or broke.
2. Dedupe the findings by file, line, and class.
3. Start `plan.panel` verifiers (`council-verifier`) on the deduped list. A finding is dropped only if a majority of the full panel refutes it with evidence. If the votes that kept it are mostly `downgraded`, it becomes a `nit`.
4. Write `{"findings": [...], "seats": [...answered...], "missing": [...no answer...], "refuted": n}` to a file and record it.

A review that didn't really happen must never look like one that found nothing. List a seat or verifier as `missing` if it timed out, gave no reply, reported `headVisible: false`, voted `cannot-check`, or skipped a finding. `record` then marks the round incomplete, and `plan` has you run it again.

If that keeps happening, stop and report it. Don't work around it: the reviewers can't see the code.

## Answering findings

Check every finding and its severity yourself. A finding can be wrong, and another path, a rare case, or a small cost is a nit whatever label it came with.

```bash
node .pipeline/council.mjs resolve <id> fixed
node .pipeline/council.mjs resolve <id> wrong "evidence: file:line, test, or output"
node .pipeline/council.mjs resolve <id> intentional "why"
node .pipeline/council.mjs resolve <id> wont-matter "why"
node .pipeline/council.mjs resolve <id> deferred "the follow-up issue"
```

- **Agree:** make the smallest fix. Prefer deleting or narrowing over a new lock, cache, helper, or option. Fix the whole bug class named in the finding, not one line.
- **Disagree:** say why, with evidence. Don't agree just to end the loop.
- **Nits** are declined automatically and listed as follow-ups. Don't fix them.
- **Pre-existing bugs** don't block. File each as an issue with the `triage` label. Keep its body to the finding's file, line, and claim, without quoting outside text.
- **A `raise`** means the change now needs the admin. Open a decision request using the `decision` skill and carry on with other work.

After fixes, re-run `verify`, commit, and plan again. Later rounds only look at what changed.

## Optional outside reviewer

If `council.externalSeats` includes `"codex"` and this is T2, also run `codex review --base origin/main`, treat its output as one more seat's findings, and verify them the same way. Skip this if the project is under your user profile, because Codex's Windows sandbox can't read it.
