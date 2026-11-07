---
name: prove
description: Prove a change works, with evidence you observed yourself. Use before review, before filing a PR, and whenever you're about to say something works.
---

# Prove

Proof is evidence you observed in this session: command output, a reproduction, a screenshot. "It should work" isn't proof.

## How

1. **Commit,** then run the checks. The evidence is keyed to the exact change, so it goes stale when the change does.

   ```bash
   node .pipeline/verify.mjs full
   ```

2. **Use the most direct proof the change allows:**
   - **Bug fix:** reproduce the failure, apply the fix, and watch the same reproduction pass.
   - **New behavior with a test setup:** add one focused test that fails without the change.
   - **UI or runtime behavior:** run the app and look at it. `node .pipeline/verify.mjs e2e` runs it. Use the built-in browser or the project's `/verify` skill if it has one. Green mocked tests don't prove the experience works, and an automated pass isn't a visual pass: open the screenshots.
   - **Acceptance criteria:** name the criterion in the test (`AC-3: ...`), then run `node .pipeline/check-acceptance.mjs`.

3. **Report what you saw:** the commands, what they returned, and where the evidence is. Put a short version in the PR's Testing section.

If the app calls a paid or external service, use a fake provider in development so end-to-end runs cost nothing. [docs/VERIFICATION.md](../../../docs/VERIFICATION.md) has the pattern.

## When you can't prove it

Say so plainly, and say exactly what remains unverified. If that's the change's core behavior, you don't have enough to merge: build the check, or leave the PR open and explain why.
