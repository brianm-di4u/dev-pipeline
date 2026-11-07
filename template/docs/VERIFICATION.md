# Verification guide

The agent can only be as good as what it can check. A smart newcomer who's never seen this project should be able to run one command and know whether their change works.

## Three levels

| Command | Purpose | When |
|---|---|---|
| `node .pipeline/verify.mjs fast` | Lint and quick tests, in seconds | Constantly |
| `node .pipeline/verify.mjs full` | Everything CI runs | Before every PR |
| `node .pipeline/verify.mjs e2e` | The real app, used the way a user would | When behavior changes |

The commands live in `pipeline.config.json`. Evidence is written to `.pipeline/evidence/<change-hash>/`.

## Make the real app checkable

Green mocked tests don't prove the experience works. An agent has to be able to launch the app, drive it, and see the result.

- **Test hooks:** expose a small, documented API for tests, so they can set state and jump to screens. The browser packs use `window.__game`.
- **Screenshots:** take named ones at desktop and mobile sizes, and open them. An automated pass isn't a visual pass.
- **Determinism:** seed randomness and freeze clocks, so that a failure can be reproduced.
- **Recording:** for tricky UI changes, record a short video and attach it to the PR.

## Fake providers: end-to-end runs that cost nothing

If the app calls a paid or external service, such as an LLM, a payment gateway, or email, add a development-only fake that returns canned responses through the same code path:

- The fake lives behind the same interface as the real provider, so everything else runs for real.
- It's selected by configuration, and can't be turned on in a production build.
- It has scripted scenarios, including failures, slow responses, and malformed data.

An agent can then run a full end-to-end test without spending tokens or touching real accounts.

## When something's hard to check

Building the check is usually worth it, even if it's a lot of work. Code that's hard to check is hard for anyone to work in. If you truly can't check something, say so in the PR's Risk section, and name what's unverified.
