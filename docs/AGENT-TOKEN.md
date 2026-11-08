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

In your own terminal, store it in a separate GitHub CLI profile, so it doesn't replace your own login:

```powershell
$env:GH_CONFIG_DIR = "$HOME\.config\gh-agent"
gh auth login --with-token
```

Paste the token, press Enter, and then press Ctrl+Z and Enter. Then make it the default for agent sessions by adding this to `~/.claude/settings.json`. The `GIT_CONFIG` lines matter: on Windows, `git push` otherwise uses your own login from Git Credential Manager, whatever `gh` is set to.

```json
{
  "env": {
    "GH_CONFIG_DIR": "C:\\Users\\<you>\\.config\\gh-agent",
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "credential.helper",
    "GIT_CONFIG_VALUE_0": "",
    "GIT_CONFIG_KEY_1": "credential.helper",
    "GIT_CONFIG_VALUE_1": "!gh auth git-credential"
  }
}
```

Confirm it took effect from a Claude Code session in one of your projects:

```bash
node "C:\Development Pipeline\bin\pipeline.mjs" doctor
```

The `Agent token` line should now say `ok`.

To prove the limits hold, run this from the same kind of session, against a clone of a sandbox repo. It tries to turn off protection, change settings, push a workflow, and forge the gate, and it checks that normal work still functions:

```bash
node "C:\Development Pipeline\tests\e2e\agent-token.mjs" <sandbox-clone>
```

## When you need your own token

Run `pipeline init`, `protect`, and `update` from your own terminal, where `GH_CONFIG_DIR` isn't set. Those three need Administration or Workflows access, which is why they're yours.

## What this doesn't do

Your full token still sits in Windows Credential Manager on the same machine. The guard hook blocks the obvious ways of reading it, but it's a pattern match, not a wall. And the agent token can still post a comment under your login, so GitHub can't tell who wrote an `/approve`. The immediate @mention and the digest make a rogue approval visible, but they don't prevent one. See [design.md](design.md) for the options if you ever want more.
