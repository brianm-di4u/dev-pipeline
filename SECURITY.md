# Security

## Reporting a vulnerability

Report it privately: on this repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue, PR, or discussion about it.

Include what's affected (the CLI, the template, or a pack), how to reproduce it, and what an attacker could do with it. You'll get an acknowledgement within a week.

## What's in scope

- `bin/pipeline.mjs` and everything under `template/` and `packs/`, since projects copy them.
- Ways a PR or an agent could get past the merge gate, the guard hook, or branch protection that `pipeline protect` sets up.
- Workflows that could leak a token or run untrusted code with write access.

Weaknesses this project already accepts are listed in [docs/design.md](docs/design.md). A report that shows one of them is worse than described there is still welcome.

## Supported versions

Only the latest commit on `main`. Fixes aren't backported, and projects already scaffolded don't pick them up on their own.
