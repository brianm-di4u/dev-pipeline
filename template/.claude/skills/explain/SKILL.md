---
name: explain
description: Explain a part of the codebase or a PR for someone about to work on it or decide about it. Use when asked to explain, break down, or teach code, or what a PR changes and where the risk is.
---

# Explain

Nobody needs a complete mental model of the code. People need to understand the slice in front of them, as it is today. Write an explainer for exactly that slice.

## Read first

Read the actual code, including its tests and callers. Check `docs/decisions/` for why it's this way. Don't rely on memory or old documentation, and cite `file:line` for every claim.

## For a part of the code

1. **What it's for,** in a sentence or two.
2. **How it works:** the flow from input to output, following the real path through the code.
3. **What it depends on and what depends on it.**
4. **What to watch out for:** invariants, surprising behavior, and what breaks if you change it.
5. **Where to start** if you're changing it.

## For a PR

1. **What's changing,** in plain words.
2. **Why it's changing.**
3. **Where the risk is,** and what the checks wouldn't catch.
4. **What you'd want to look at yourself,** if anything.

Use the PR's council verdict and evidence, and say where you disagree with them.

## Format

Lead with the answer, and keep it as short as the slice allows. If a picture would help, or someone asks to learn it visually, build a small visual artifact that shows the real structure. Fit it to how that person likes to learn.

Don't commit the explainer unless asked. It's meant to reflect the code today, and it's cheap to regenerate.
