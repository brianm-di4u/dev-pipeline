---
name: release
description: Cut a release in stages, with a changelog and a tested way back. Use when asked to release, publish, or ship a version.
---

# Release

Release assets can't be built in CI: there are about 70 of them, over 4 GB, including a Windows installer and Linux packages built in WSL. So they're built on the admin's PC, and CI checks the source and holds the draft.

## Stop first

**Every public release needs a decision from the admin,** including a patch. `docs/POLICY.md` has the rule: O-15, O-16, and S-10 must be answered, or waived for this exact version. A waiver never carries over. Use the `decision` skill, keep any legal detail out of the public issue, and don't go on until it's answered.

Main must be green, with no open `pipeline:main-red` issue or tripped breaker, and no open `triage` issue from the nightly run that affects this release.

## Steps

1. **Pick the version** by semantic versioning. Use `-beta.N` or `-rc.N` for a prerelease.
2. **Open a release PR** that sets the version in `package.json`, updates `CHANGELOG.md` in words a user would understand, and carries any translation increment. Merge it through the gate.
3. **Run the release gate** on a fresh checkout of that commit on the admin's PC:

   ```bash
   node .pipeline/verify.mjs e2e
   ```

   SDP §7.4 applies: exit scenarios on the built file, all Musts, performance on the reference laptop, zero open fuzz crashes, and honest limits in Help. Run `npm run trace`, and write the validation report in the private repo.
4. **Build the assets** with the tooling in `build/release/`, and check them against `SHA256SUMS`.
5. **Cut the draft.** The admin runs the `release` workflow with `action: cut`, the version, and the commit. It refuses a commit not on main, or a version that doesn't match `package.json`. It runs everything again, then creates a draft prerelease. GitHub creates the tag when the draft is published. Agents can't run this, on purpose.
6. **Upload the assets** to the draft, and compare every digest with `SHA256SUMS`.
7. **Publish** the draft as a prerelease, which needs the admin's go. Watch it for the soak time in `docs/RUNBOOK.md`.
8. **Promote it** with `action: promote`.
9. **Update the site** in a PR on the site repo: app files, changelog, and `BUILD`. The admin merges, and pushing to main deploys production. Check the live app's hash against `SHA256SUMS`.

## If it goes wrong

Follow [docs/ROLLBACK.md](../../../docs/ROLLBACK.md). Write an incident record, and add an eval case.
