---
name: release
description: Cut a release in stages, with a changelog and a tested way back. Use when asked to release, publish, or ship a version.
---

# Release

## Before you start

The first public release, and any breaking release, needs a decision from the admin. Use the `decision` skill, and don't release until it's answered. Other releases are yours to make.

Main must be green, with no open `pipeline:main-red` issue or tripped breaker.

## Steps

1. **Pick the version** by semantic versioning: a breaking change is major, a new feature is minor, and a fix is patch.
2. **Update `CHANGELOG.md`** on a branch, in words a user would understand, and merge it through the gate.
3. **Run the full check** against a fresh checkout of main: `node .pipeline/verify.mjs full`, then `e2e`.
4. **Tag it,** which needs the admin's own credentials or the release workflow's dispatch if one is set up:

   ```bash
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

   `release.yml` builds from the tag and publishes it to the `latest` channel.
5. **Watch it.** Run the smoke check against what you released, and let it soak for the time set in `docs/RUNBOOK.md`.
6. **Promote it** to `stable` by running the release workflow with `promote` set to the tag.

## Flags

Ship risky behavior behind a flag that's off by default, using `src/flags` or the project's equivalent. Turning a flag off needs no deploy, so that's the fastest way back. Delete a flag once its feature has been stable for a release.

## If it goes wrong

Follow [docs/ROLLBACK.md](../../../docs/ROLLBACK.md): turn off the flag, or re-promote the last good tag, and then fix it on a branch. Write an incident record, and add an eval case.
