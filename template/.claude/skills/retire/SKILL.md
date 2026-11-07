---
name: retire
description: Shut a project down cleanly once the admin has decided to. Use when asked to retire, sunset, archive, or decommission a project.
---

# Retire

Retiring a project is the admin's decision. If there isn't one recorded in `docs/decisions/`, open a decision request with the `decision` skill, and stop there.

Once it's decided, make a checklist from this list, and work through it:

## Tell people

- [ ] Say it's retiring, and by when, wherever users would see it: README, the app, and the release notes.
- [ ] Point to an alternative, or to a way to export their data, if one applies.

## Data

- [ ] List what data exists and where. See `docs/THREAT-MODEL.md`.
- [ ] Export or delete it as the decision says. **Deleting data is irreversible, so confirm the specific deletion with the admin first.**
- [ ] Note how long backups last.

## Services and money

These are outside the repo, so propose each one to the admin rather than doing it:

- [ ] Hosting, domains, and app store listings.
- [ ] Paid services, API keys, and tokens to revoke.
- [ ] Scheduled tasks and autopilot runs to stop.

## The repository

- [ ] Merge or close open PRs, using `modernize` to decide.
- [ ] Close the issue queue, with a note on anything worth keeping.
- [ ] Tag the final state, and write the retirement record in `docs/decisions/`.
- [ ] Update the README, stating that it's retired and why.
- [ ] Ask the admin to archive the repo. Archiving is reserved for them.
