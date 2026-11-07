# {{PROJECT}}

@.pipeline/AUTONOMY.md

## Project

What this is, who it's for, its goals, and its non-goals are in [docs/PRD.md](docs/PRD.md). Decisions already made are in [docs/decisions/](docs/decisions/).

## Commands

- `node .pipeline/verify.mjs fast`: quick checks, run often.
- `node .pipeline/verify.mjs full`: what CI runs. Must pass before a PR.
- `node .pipeline/verify.mjs e2e`: run the real app.
- `node .pipeline/gate.mjs classify`: this branch's change hash and tier.
- `node .pipeline/gate.mjs local`: check the gate for the current PR.

## Conventions

<!-- Add only what a smart newcomer can't learn from the code or from lint. Keep this short. -->
