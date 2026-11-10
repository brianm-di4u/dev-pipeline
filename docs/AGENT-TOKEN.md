# The restricted agent token

Agents share your GitHub account, but they shouldn't hold your full token. With it, an agent that went wrong could turn off the very protection that gates it. A restricted token closes that hole while keeping one account.

**You have to create this token yourself.** No agent should ever handle it. This takes about five minutes, once.

## What it allows

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | Push branches, merge PRs |
| Pull requests | Read and write | Open and update PRs |
| Issues | Read and write | The queue and decision requests |
| Actions | Read | See CI results |
| Commit statuses | Read | See statuses |
| Administration | **Read only** | `doctor` can read protection. It can't change it |
| Metadata | Read | Required |

Fine-grained tokens have no Checks permission. Agents only read the gate's check run, which on a public repo needs none.

Leave everything else at **No access**. In particular:

- **Administration write:** this is what could turn off protection.
- **Workflows:** this is what could change CI. Without it, a push touching `.github/workflows/` is refused.
- **Secrets and Variables:** agents never need these.

## Create it

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Name it `dev-pipeline-agents`, and set an expiration you're willing to renew.
3. Under **Repository access**, choose **All repositories**, or only the ones agents work in.
4. Set the permissions above.
5. Generate it, and copy it. You won't see it again.

## Give it to agents

Give agent sessions the token through `GH_TOKEN`. Open `~/.claude/settings.json` in your own editor, not through an agent, and add this, pasting the token in place of `<token>`:

```json
{
  "env": {
    "GH_TOKEN": "<token>",
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "credential.helper",
    "GIT_CONFIG_VALUE_0": "",
    "GIT_CONFIG_KEY_1": "credential.helper",
    "GIT_CONFIG_VALUE_1": "!gh auth git-credential"
  }
}
```

`gh` reads `GH_TOKEN` ahead of any stored login, so agent sessions use the agent token and your own terminal, which doesn't set it, keeps your login. The `GIT_CONFIG` lines matter: on Windows, `git push` otherwise uses your own login from Git Credential Manager, whatever `gh` is set to. With them, git asks `gh`, and `gh` answers with `GH_TOKEN`.

The token sits in that file in plain text. Keep the file out of any repository.

**Don't store the agent token with `gh auth login`, even in a separate `GH_CONFIG_DIR` profile.** When both tokens are for the same account, it doesn't work. `gh` keeps tokens in the system keyring, keyed by host and account, not by profile, so logging in the agent token overwrites your own keyring login. And `gh` reads the keyring ahead of the profile's `hosts.yml`, so the profile doesn't isolate anything. If you already tried it, run `gh auth login` again from your own terminal to put your login back.

Confirm it took effect from a Claude Code session in one of your projects:

```bash
gh auth status
node "C:\Development Pipeline\bin\pipeline.mjs" doctor
```

`gh auth status` should show the active account as `(GH_TOKEN)` with a `github_pat_` token, and your own `gho_` login in the keyring as inactive. The doctor's `Agent token` line should say `ok`.

To prove the limits hold, run this from the same kind of session, against a clone of a sandbox repo. It tries to turn off protection, change settings, push a workflow, and forge the gate, and it checks that normal work still functions:

```bash
node "C:\Development Pipeline\tests\e2e\agent-token.mjs" <sandbox-clone>
```

## When you need your own token

Run `pipeline init`, `protect`, and `update` from your own terminal, where `GH_TOKEN` isn't set. Those three need Administration or Workflows access, which is why they're yours.

## A delegate's token

A delegate is a second GitHub account that may post some of the approval commands, listed under `delegates` in the project's `pipeline.config.json`. GIS Workbench's, for example:

```json
"delegates": [{ "login": "gwb-gardener", "approve": true,
                "decide": ["design", "security", "determination"],
                "rearm": true, "direct": true }]
```

Its session must act as that account, so it gets a token of its own, in its own clone, and never your agent token.

1. **Create the account,** such as `gwb-gardener`, with its own email and two-factor authentication. Invite it as a collaborator on the target repo and on the sandbox repo used for `tests/e2e/delegate.mjs`, and nothing else. Accept both invitations as the delegate.

   **Sign in as the delegate only in a private window or a separate browser profile, and sign out when you're done.** Everything you do in a browser signed in as the delegate is the delegate's, including an `/approve` you meant as your own. GitHub counts it as the delegate's command, and the bot records it as one. If that happened while no delegate was configured, see `since` below.
2. **Create a classic token** on the delegate account, at [github.com/settings/tokens/new](https://github.com/settings/tokens/new), with only the `public_repo`, `workflow` and `read:org` scopes. Do it in that private window too.
   - **Classic,** because fine-grained tokens don't work on a repo the account is only a collaborator on.
   - **`workflow`** lets the delegate relay a workflow branch an agent can't push. That scope can also forge the gate, which [design.md](design.md) lists as an accepted risk.
   - **`read:org`** is there because some `gh` commands, such as `gh pr edit` and the default `gh pr view`, ask GitHub for team and organization fields and fail without it. It reads; it can't change anything.
3. **Clone the repo for the delegate,** for example to `C:\GIS Workbench\gwb-garden`, and set that clone's git identity to the delegate account.
4. **Run the setup script from your own terminal,** not from an agent:

   ```powershell
   pwsh -File "C:\Development Pipeline\tools\setup-delegate.ps1" -Clone "C:\GIS Workbench\gwb-garden"
   ```

   It prompts for the token without echoing it, shows which account and scopes it belongs to, and asks before writing. It writes the clone's `.claude/settings.local.json` with `GH_TOKEN`, the same `GIT_CONFIG` lines as above, and a `model` key (`-Model` changes it). It then adds that file to the clone's `.git/info/exclude`. It never prints the token.
5. **Check it.** From your own terminal, `git -C <clone> check-ignore -v .claude/settings.local.json` should name `.git/info/exclude`. Agent sessions can't run that one, because the guard denies any command that names the file. Then open the clone in Claude Code once, accept the trust prompt, and in that session `gh api user --jq .login` should print the delegate's login, such as `gwb-gardener`. `pipeline doctor` reports the classic token as expected for a delegate.

The guard lets a session post `/approve`, `/decide`, or `/rearm` only when `gh api user` names a delegate in the default branch's config, and only the commands its grant covers. If the local settings' `GH_TOKEN` doesn't reach the hook, `gh` falls back to your keyring login, which isn't a delegate, so the guard denies. That is the safe failure.

**`since` keeps earlier commands out.** A delegate's command counts only if it was posted at or after its entry's `since`, an ISO date and time such as `"2026-11-10T00:00:00Z"`. Without `since`, a command the account posted before it was configured, for example from a browser left signed in as the delegate, starts counting once the `delegates` key lands, if its PR is still open at the same change. Set `since` to the time you add the entry.

**`id` ties the entry to one account.** A login can change hands, for example after an account is renamed or deleted, but a user id can't. Set `id` to the delegate account's numeric user id, from `gh api users/<login> --jq .id`. Then only that account's commands count, and the guard lets a delegate session post only when it is that account. Whether or not `id` is set, a delegate's command counts only when GitHub shows on the comment that its author has access to the repo, so the account must stay a collaborator.

The token sits in plain text in that file, which any process running as your Windows user can read. The template's settings deny agent sessions a `Read` of `//**/.claude/settings.local.json`, which matches that file anywhere on the machine, including a sibling clone. Claude Code applies a `Read` deny to Grep, Glob, and the shell commands it recognizes, such as `cat`, on a best-effort basis, and the guard denies any shell command that names the file. Neither stops a script that reads it indirectly. Moving the delegate to its own Windows user is the stronger fix.

## What this doesn't do

Your full token still sits in Windows Credential Manager on the same machine. The guard hook blocks the obvious ways of reading it, but it's a pattern match, not a wall. And the agent token can still post a comment under your login, so GitHub can't tell who wrote an `/approve`. The immediate @mention and the digest make a rogue approval visible, but they don't prevent one. See [design.md](design.md) for the options if you ever want more.
