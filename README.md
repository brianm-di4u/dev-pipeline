# dev-pipeline

A drop-in template for autonomous AI software development: **agents build, a human decides.**

Start a new project with one command, and it comes with a merge gate that a PR can't rewrite, a council of specialist AI reviewers whose review rounds always end, fast rollback, a circuit breaker, and a path through the whole project lifecycle. You weigh in only on design, go/no-go, legal, security, and other major decisions.

It's built from [how the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/), a public critique of that post, and the [tstack](https://github.com/t3dotgg/tstack) skills. [docs/source-analysis.md](docs/source-analysis.md) covers what was adopted and why, and [docs/design.md](docs/design.md) traces each capability to its source and lists the accepted risks.

## Start a project

You need Node 22+, git, an authenticated `gh`, and Claude Code v2.1.295+.

```bash
node "C:\Development Pipeline\bin\pipeline.mjs" init "C:\Projects\my-app" --pack node-ts
```

That scaffolds the project, creates the GitHub repo, turns on protection, and prints what's enforced. Then open the project in Claude Code and run `/start-project`.

| Pack | For |
|---|---|
| `generic` | Any stack. You fill in the verify commands |
| `browser-game` | Browser apps and games: self-contained pages tested in real browsers, with screenshots |
| `web-wasm-rust` | Code-only HTML apps with JavaScript, WASM, and Rust |
| `node-ts` | Node and TypeScript web apps and API services |
| `desktop-mobile` | Tauri desktop apps, with a path to Android and iOS |

Options: `--private`, `--repo owner/name`, and `--no-github`.

**Public or private matters.** On GitHub's Free plan, only public repos get CI and enforcement here. A private repo gets the same checks locally, but nothing stops a bypass, so agents stop at ready and you merge. `pipeline doctor` tells you which you've got.

**Do this once:** give agents [a restricted token](docs/AGENT-TOKEN.md).

## How a change flows

```text
ready issue → branch → prove (run it, keep evidence) → council (specialist reviewers, verified findings)
  → PR with Testing, Risk, and How to revert → gate → merge → verify on main → digest
```

The gate sets a tier from what changed, not who changed it:

| Tier | What | Review | Merge |
|---|---|---|---|
| **T0** | Markdown docs, verified clean reverts | 2 Sonnet seats, 1 round | Automatic |
| **T1** | Everything ordinary | Full council, 3 rounds at most | Automatic |
| **T2** | Protected paths, outsiders, anything raised by the council | Opus seats, 5 rounds at most | After your `/approve <hash>` |

## What you do

- **Answer decisions.** Agents open `decision-needed` issues and carry on with other work. Reply with `/decide <option>`.
- **Approve T2 changes.** Reply `/approve <hash>`, exactly as the check shows it.
- **Read the weekly digest.** It's the one thing you routinely look at.
- **Re-arm the breaker** if it trips, with `/rearm`.
- **Run `pipeline init`, `protect`, and `update`.** They need your own credentials.

Those commands count only as a comment's entire body, from you, unedited. Everything else is the agents' job.

## Skills in every project

| Skill | What it does |
|---|---|
| `/start-project` | Set intent, scope, and decisions with you, then fill the queue |
| `/autopilot` | Work the `ready` queue, one PR at a time, until something says stop |
| `/full-send` | Take one change all the way to merged |
| `/full-stop` | The same, but leave the PR ready for you |
| `/prove` | Show evidence that a change works |
| `/council` | Run the specialist review, in rounds that always end |
| `/file-pr`, `/babysit-pr` | File a PR, and watch it through |
| `/decision` | Ask you something, park that work, and carry on |
| `/explain` | Explain a slice of the code or a PR |
| `/sweep` | Review a slice of old code for bugs |
| `/release`, `/incident`, `/retire` | Ship in stages, handle breakage, and shut down cleanly |
| `/reviewer-eval` | Score the council against known bugs |
| `/modernize`, `/takeover` | Revive an old PR, or finish someone else's |

## Keeping projects current

Run this in a project, from your own terminal:

```bash
node "C:\Development Pipeline\bin\pipeline.mjs" update
```

It updates pipeline files, keeps anything changed locally, and never touches files the project owns. If a broken gate ever can't approve its own fix, `pipeline protect --off` is the break-glass, followed by `pipeline protect`.

## Developing this template

```bash
npm test
```

`tests/e2e/sandbox.mjs` attacks a real public GitHub repo, and `tests/e2e/packs.mjs` builds every pack for real.
