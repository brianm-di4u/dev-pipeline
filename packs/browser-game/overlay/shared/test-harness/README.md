# Test harness

Playwright runner that loads a game in headless Chromium at desktop and mobile sizes,
drives it through its `window.__game` test hooks, and saves screenshots for visual review.

```bash
# one-time setup (from the repo root)
cd shared/test-harness && npm install && npx playwright install chromium && cd ../..

node shared/test-harness/run.mjs games/<slug>                    # all tests, both viewports
node shared/test-harness/run.mjs games/<slug> --milestone m2     # screenshots → screenshots/m2/
node shared/test-harness/run.mjs games/<slug> --only rules --viewport mobile
node shared/test-harness/run.mjs games/<slug> --file touch      # only tests/*touch*.test.mjs
node shared/test-harness/run.mjs games/<slug> --gpu              # real GPU (HS_GPU=1 does the same)
node shared/test-harness/run.mjs games/<slug> --file-url         # load every test from file://, as a player would
node shared/test-harness/run.mjs games/<slug> --slow --clean     # include slow tests; delete old shots first
node shared/test-harness/run.mjs smoke                           # harness self-test
node shared/test-harness/gallery.mjs games/<slug>                # rebuild screenshots/index.html
node shared/test-harness/sheets.mjs games/<slug> --milestone final  # contact sheets for review
node shared/test-harness/sheets.mjs games/<slug> --milestone visual-final --compare visual-before  # before/after pairs
```

| Option | Effect |
|---|---|
| `--only <s>` | tests whose name **or file name** contains `s` |
| `--file <s>` | only `tests/*<s>*.test.mjs` |
| `--gpu` | launches Chromium with `--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11` (metal / gl off Windows). Headless Chromium otherwise renders WebGL in SwiftShader, 5–20× slower than a real device, so 3D games fall back to low tiers and `t.fps` measures the rasterizer. Use it for 3D shots and frame rates |
| `--file-url` | loads each test's `url` from `file://` instead of the local server. Catches what only file:// breaks: tainted canvases from local images, `fetch` of local files, ES-module imports. Only files inside the game's folder may load. A single test can opt in with `fileUrl: true` |
| `--slow` | also runs tests marked `slow: true` (they always run at `--milestone final`) |
| `--clean` | deletes the milestone's old screenshots first (files only; a Windows shell inside the folder locks it). Ignored with `--only`/`--file` |

| Viewport | Size | Scale | Touch |
|---|---|---|---|
| `desktop` | 1280×800 | 1× | no |
| `mobile` | 390×844 | 2× | yes |

The game is served from a local static server rooted at the repo, so the URL is
`http://127.0.0.1:<port>/games/<slug>/index.html`. **Every request that leaves that server is
blocked and fails the test**: games must be fully self-contained. **Any console error or uncaught
exception fails the test** unless the test sets `allowConsoleErrors: true`.

Output, per run: `games/<slug>/screenshots/<milestone>/<viewport>/<name>.png`, a
`report.json` beside them, and a regenerated `games/<slug>/screenshots/index.html` gallery.

## Writing tests

Put files named `*.test.mjs` in `games/<slug>/tests/`. **Don't import `playwright`** from them;
everything comes through `t`.

```js
export const tests = [
  {
    name: 'deal a seeded game',
    viewports: ['desktop', 'mobile'],   // optional, default both
    url: 'index.html?mode=klondike',    // optional, relative to the game folder
    reducedMotion: false,               // optional, emulates prefers-reduced-motion
    colorScheme: 'light',               // optional, 'light' | 'dark'
    initScript: () => { localStorage.setItem = () => { throw new Error('blocked'); }; }, // optional, runs before page scripts on every load
    fileUrl: false,                     // optional, load this test from file:// (see --file-url)
    slow: false,                        // optional, skip unless --slow or --milestone final
    node: false,                        // optional, run in Node with no browser (rule solvers, data checks); t has only expect/equal/fail/log
    async run(t) {
      await t.seed(7);
      await t.game('newGame', { mode: 'klondike' });
      const s = await t.state();
      t.equal(s.tableau.length, 7, 'seven tableau piles');
      await t.shot('01-deal');
      await t.page.mouse.click(400, 300);   // full Playwright page API
      await t.checkLayout();
    },
  },
];
```

### The `t` API

| Member | What it does |
|---|---|
| `t.page` | the Playwright `Page` |
| `t.viewport`, `t.vp` | `'desktop'` / `'mobile'` and its size |
| `t.game(method, ...args)` | calls `window.__game[method](...args)` in the page and returns the (JSON-serializable) result |
| `t.state()` / `t.seed(n)` | shorthands for `getState()` / `seed(n)` |
| `t.waitForStable(ms)`, `t.waitIdle(ms)` | waits two frames, then for `__game.isIdle()` to return true |
| `t.waitForAnimations(ms)` | waits for finite CSS animations and transitions (a fading toast, a sliding dialog) to finish; infinite ones are ignored |
| `t.shot(name, {fullPage, allowBlank, wait, timeout, animations})` | waits for stable, saves the PNG, **fails if it looks blank**, returns `{file, stats:{mean,stddev,colors}}`. `wait: false` captures immediately, for mid-animation frames. `timeout` (default 5000) bounds the `isIdle()` wait; raise it for software-rendered 3D. `animations: true` also waits for CSS animations |
| `t.reload()` | reloads and waits for `window.__game` again (storage and `initScript` persist) |
| `t.touchDrag([x,y], [x,y], {steps, holdMs, holdEndMs})`, `t.tap([x,y])` | real touch input via CDP. `holdMs` waits after touchStart; `holdEndMs` keeps the finger down at the end point before lifting (held sticks, press-hold-release casts). Under the mobile viewport `page.mouse` does **not** produce `pointerType: 'touch'` events |
| `t.waitFrames(n = 2)` | let the game loop run n animation frames, e.g. camera settling right after `setState` |
| `t.stepUntil(pred, {max, chunk, label})` | steps a paused game `chunk` ticks at a time (in the page, fast) until `pred(state)` holds, up to `max` ticks; fails the test on timeout and returns the last state. `pred` is serialized, so it can't use variables from the test file. It is checked between chunks, so test "has happened" state (a counter, a flag), not a one-tick window, or pass `chunk: 1` |
| `t.milestone`, `t.shotDir` | the current milestone name and this viewport's screenshot folder |
| `t.checkLayout({allowScrollY})` | fails on horizontal overflow or controls positioned off-screen |
| `t.fps(ms)` | average requestAnimationFrame rate over `ms`. **Load-dependent**: with other browsers running it can swing from 60 to 7 for the same build |
| `t.frameCost(ms)` | main-thread CPU time per frame from CDP Performance metrics (thread time), `{frames, fps, taskMs, scriptMs, layoutMs, styleMs}`. Stable under machine load; budget against `taskMs` (well under 16.7 for 60 fps), and report `fps` beside it |
| `t.cpuThrottle(rate)` | CDP CPU throttling, e.g. `4` for a mid-range phone; `1` turns it off |
| `t.contrastReport({selector, min, largeMin, fallbackBg, skip, fail})` | WCAG contrast of visible text against its nearest opaque background: `{checked, fails[]}`. Skips hidden, `.sr-only`, `aria-hidden` and disabled elements; large text needs 3:1, the rest 4.5:1. `fail: true` fails the test on each miss |
| `t.gpu`, `t.fileUrl` | whether this run uses the real GPU / file:// |
| `t.memoryMB()` | JS heap in MB (Chromium only) |
| `t.loadMs` | time from navigation to `window.__game` appearing |
| `t.expect(cond, msg)`, `t.equal(a, b, msg)`, `t.fail(msg)` | assertions; failures are collected and the test keeps running |
| `t.log(...)` | prints a note under the test result |

## The `window.__game` contract

Every game exposes this object. Methods may be sync or async and must return JSON-serializable values.

| Method | Required | Purpose |
|---|---|---|
| `seed(n)` | yes | reseed the game's RNG so deals, AI and spawns are reproducible |
| `getState()` | yes | a JSON snapshot of the game state the tests assert on |
| `setState(s)` | yes | load a crafted state (e.g. one move from winning) and redraw |
| `isIdle()` | yes | `true` when no animation or transition is in flight |
| `step(n)` | real-time games | advance the simulation `n` fixed ticks while paused |
| `pause()` / `resume()` | real-time games | freeze and unfreeze the main loop |
| `scene(name)` | yes | jump straight to a screen: `'title'`, `'game'`, `'settings'`, `'help'`, `'win'` … |
| `newGame(opts)` | yes | start a new game with options |
| `act(name, ...args)` | optional | perform a named player action without pointer input (`act('move', from, to)`) |

`window.__TEST__` is `true` during tests. Games may use it to skip intro timers or attract
modes, but must not change rules or rendering because of it.

### `isIdle()` and `t.shot`
`t.shot` waits up to 5 s for `isIdle()`. Leave ambient loops (steam, camera drift, title attract
animation) **out** of `isIdle()`, and count transitions and entry animations **in** it, or every
shot either stalls 5 s or catches a half-faded modal. For deliberate mid-animation frames, freeze
the animation clock with a game hook (e.g. `act('animAt', ms)`) or use `t.shot(name, {wait: false})`.

### `report.json`
`screenshots/<milestone>/report.json` is `{game, milestone, started, finished, passed, failed,
gpu, fileUrl, tests: [{name, file, viewport, pass, ms, failures[], logs[], shots: [{name, file, stats}]}]}`.
A filtered run (`--only`, `--file`, one `--viewport`) **merges** into the existing report: its tests replace
the same name and viewport, `lastRun` lists what that run touched, and `passed`/`failed` count the whole.
Node-only tests have viewport `"node"`.

## Visual validation

Automated checks only catch blank frames, overflow and errors. **Every screenshot must also be
opened and inspected** (the Read tool renders PNGs) against the PRD: layout, legibility, theme
fidelity, overlap/clipping, touch-target size on mobile, and both color schemes if supported.
Log defects in the game's `DEV-PLAN.md`, fix, and re-shoot.

`sheets.mjs` tiles a milestone into labelled grids (`screenshots/<milestone>/sheets/`, 6 desktop or
8 mobile shots per sheet; captions name the test that took each shot) so a full pass costs a handful of
image reads. `--compare <milestone>` pairs each shot with the same-named shot of an earlier milestone in
`screenshots/<milestone>/before-after/`, for visual-campaign reviews. Use sheets for the sweep,
then open single shots at full size for anything small: text, touch targets, tile faces.

Screenshots are **not committed** (`games/*/screenshots/` is gitignored; each final run is 20–35 MB).
They are a review record on the machine that ran them; anyone can regenerate them with the commands above.

## Performance on a shared machine

Several sessions often run browser suites at once, so rAF fps is noise. Budget performance with
`t.frameCost()` and log `t.fps()` beside it; measure 3D games with `--gpu`. For a phone-class check,
call `t.cpuThrottle(4)` before measuring.
