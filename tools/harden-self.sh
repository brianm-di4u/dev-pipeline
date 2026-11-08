#!/usr/bin/env bash
# Hardens this repository's own GitHub settings. Owner only: it needs Administration write,
# which the restricted agent token (docs/AGENT-TOKEN.md) deliberately lacks. It drops GH_TOKEN
# for its own process so gh uses your keyring login, and leaves your shell as it was.
# Safe to re-run. Break glass: disable the "main protection" ruleset in Settings > Rules.
set -uo pipefail
unset GH_TOKEN GITHUB_TOKEN

REPO="${1:-brianm-di4u/dev-pipeline}"
ACTIONS_APP_ID=15368
failed=0

step() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    echo "ok    $name"
  else
    echo "FAIL  $name: $(echo "$out" | head -3)"
    failed=1
  fi
}

admin="$(gh api "repos/$REPO" --jq .permissions.admin 2>/dev/null)"
if [ "$admin" != "true" ]; then
  echo "Your keyring login has no admin rights on $REPO. Run: gh auth login" >&2
  exit 1
fi
echo "Hardening $REPO as $(gh api user --jq .login)"

step "Squash-only merges, delete branches on merge, no wiki or projects" \
  gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"allow_merge_commit": false, "allow_rebase_merge": false, "allow_squash_merge": true,
 "delete_branch_on_merge": true, "squash_merge_commit_title": "PR_TITLE",
 "squash_merge_commit_message": "PR_BODY", "has_wiki": false, "has_projects": false}
JSON

ruleset="$(cat <<JSON
{"name": "main protection", "target": "branch", "enforcement": "active", "bypass_actors": [],
 "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
 "rules": [
  {"type": "deletion"},
  {"type": "non_fast_forward"},
  {"type": "required_linear_history"},
  {"type": "pull_request", "parameters": {"required_approving_review_count": 0,
    "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false,
    "require_last_push_approval": false, "required_review_thread_resolution": false,
    "allowed_merge_methods": ["squash"]}},
  {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": true,
    "do_not_enforce_on_create": false, "required_status_checks": [
      {"context": "test", "integration_id": $ACTIONS_APP_ID},
      {"context": "actionlint", "integration_id": $ACTIONS_APP_ID}]}}
 ]}
JSON
)"
existing="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="main protection") | .id')"
if [ -n "$existing" ]; then
  step "Ruleset on main (updated)" gh api -X PUT "repos/$REPO/rulesets/$existing" --input - <<<"$ruleset"
else
  step "Ruleset on main (created)" gh api -X POST "repos/$REPO/rulesets" --input - <<<"$ruleset"
fi

step "Dependabot alerts" gh api -X PUT "repos/$REPO/vulnerability-alerts"
step "Dependabot security updates" gh api -X PUT "repos/$REPO/automated-security-fixes"
step "Private vulnerability reporting" gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

step "CodeQL default setup" gh api -X PATCH "repos/$REPO/code-scanning/default-setup" --input - <<'JSON'
{"state": "configured", "query_suite": "default"}
JSON

step "Actions: GitHub-owned plus the two pinned third-party actions, SHA pins required" \
  gh api -X PUT "repos/$REPO/actions/permissions" --input - <<'JSON'
{"enabled": true, "allowed_actions": "selected", "sha_pinning_required": true}
JSON
step "Actions allowlist" gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - <<'JSON'
{"github_owned_allowed": true, "verified_allowed": false,
 "patterns_allowed": ["dtolnay/rust-toolchain@*", "taiki-e/install-action@*"]}
JSON
step "Workflow token read-only, can't approve PRs" \
  gh api -X PUT "repos/$REPO/actions/permissions/workflow" --input - <<'JSON'
{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}
JSON
step "Fork PRs from any outside contributor wait for approval" \
  gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --input - <<'JSON'
{"approval_policy": "all_external_contributors"}
JSON

echo
if [ "$failed" = 0 ]; then echo "All settings applied."; else echo "Some settings failed; see FAIL lines."; fi
exit "$failed"
