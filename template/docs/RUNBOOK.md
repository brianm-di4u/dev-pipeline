# Runbook

## When something breaks

1. **Stop the bleeding.** Revert or turn off the flag. See [ROLLBACK.md](ROLLBACK.md).
2. **Open an incident record** in `docs/incidents/` from [TEMPLATE.md](incidents/TEMPLATE.md).
3. **Fix the cause** on a branch.
4. **Add an eval case,** so the reviewer would catch this next time.

Ask the admin only if data, money, or legal exposure is involved.

## Where to look

<!-- Logs, dashboards, the smoke check, status pages. -->

## Common operations

<!-- Deploying, promoting a release, rotating a secret, restoring a backup. -->

## Dependencies

<!-- External services, who owns them, and what happens when they're down. -->
