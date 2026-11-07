#!/usr/bin/env node
// Hot Springs Games – Playwright screenshot test runner.
//
// Usage:
//   node shared/test-harness/run.mjs games/<slug> [--milestone m1] [--viewport desktop|mobile|both]
//                                               [--only <substring>] [--file <substring>] [--headed] [--no-gallery]
//                                               [--gpu] [--uncapped] [--file-url] [--slow] [--clean] [--browser chromium|firefox|webkit]
//   node shared/test-harness/run.mjs smoke
//
// Discovers games/<slug>/tests/*.test.mjs. Each test file exports:
//   export const tests = [{ name, viewports?: ['desktop','mobile'], allowConsoleErrors?: false,
//                           url?: 'index.html?x=1', initScript?: () => {...}, fileUrl?: false, slow?: false,
//                           node?: false, browsers?: ['chromium'], run: async (t) => { ... } }]
// Firefox and WebKit runs (--browser) take only tests that list that engine in `browsers`; Firefox has no mobile
// emulation, so it runs desktop viewports only. CDP helpers (touchDrag, tap, frameCost, cpuThrottle) need Chromium.
// See README.md in this folder for the `t` API. HS_GPU=1 in the environment is the same as --gpu.

// --uncapped (with --gpu) turns off vsync and the frame-rate limit, so fps measures GPU headroom.
import { chromium, firefox, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGallery } from './gallery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain',
  '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance', '.webm': 'video/webm',
};

function parseArgs(argv) {
  const a = { target: null, milestone: 'latest', viewport: 'both', only: null, file: null, headed: false, gallery: true,
    gpu: process.env.HS_GPU === '1', uncapped: false, fileUrl: false, slow: false, clean: false, browser: 'chromium' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--milestone') a.milestone = argv[++i];
    else if (v === '--viewport') a.viewport = argv[++i];
    else if (v === '--only') a.only = argv[++i];
    else if (v === '--file') a.file = argv[++i];
    else if (v === '--headed') a.headed = true;
    else if (v === '--no-gallery') a.gallery = false;
    else if (v === '--gpu') a.gpu = true;
    else if (v === '--file-url') a.fileUrl = true;
    else if (v === '--slow') a.slow = true;
    else if (v === '--clean') a.clean = true;
    else if (v === '--browser') a.browser = argv[++i];
    else if (v === '--uncapped') a.uncapped = true;
    else if (!a.target) a.target = v;
  }
  if (!a.target) {
    console.error('usage: node shared/test-harness/run.mjs games/<slug> [--milestone m1] [--viewport desktop|mobile|both] [--only name] [--file name]');
    process.exit(2);
  }
  return a;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Real-GPU Chromium (ANGLE on the platform's native API). Headless defaults to SwiftShader, which makes
// WebGL 5–20× slower than any real device and its fps meaningless.
const GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist',
  `--use-angle=${process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'}`];
const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

async function loadTests(testDir, only, file = null) {
  if (!fs.existsSync(testDir)) return [];
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs') && (!file || f.includes(file))).sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(testDir, f)).href);
    for (const t of mod.tests || []) {
      if (only && !t.name.includes(only) && !f.includes(only)) continue;
      out.push({ ...t, file: f });
    }
  }
  return out;
}

// A WCAG contrast pass over visible text, run in the page. Skips hidden, sr-only, aria-hidden and disabled
// elements; large text (24 px, or 18.66 px bold) needs 3:1, the rest 4.5:1. The background is the nearest
// opaque ancestor colour (the darker stop of a gradient), else `fallbackBg`.
function contrastInPage({ selector = 'body *', min = 4.5, largeMin = 3, fallbackBg = [255, 255, 255], skip = '' }) {
  const parse = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return { r: v[0], g: v[1], b: v[2], a: v[3] == null ? 1 : v[3] }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e), c = parse(cs.backgroundColor);
      if (c && c.a > 0.9) return c;
      const m = cs.backgroundImage && cs.backgroundImage.includes('gradient') && cs.backgroundImage.match(/rgba?\([^)]+\)/g);
      if (m) return m.map(parse).reduce((a, b) => (lum(a) < lum(b) ? a : b));
    }
    return { r: fallbackBg[0], g: fallbackBg[1], b: fallbackBg[2], a: 1 };
  };
  const fails = []; let checked = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) <= 0.5) continue;
    if (el.closest('[hidden], .sr-only, [aria-hidden="true"], [disabled]') || (skip && el.closest(skip))) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const fg = parse(st.color); if (!fg) continue;
    const bg = bgOf(el), L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(st.fontSize), large = px >= 24 || (px >= 18.66 && +st.fontWeight >= 700);
    checked++;
    if (ratio < (large ? largeMin : min)) fails.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
  }
  return { checked, fails };
}

// Pixel statistics computed in the browser from a PNG buffer (no native deps).
async function imageStats(page, buf) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const w = Math.min(img.width, 320), h = Math.round(img.height * (w / img.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let sum = 0, sum2 = 0; const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += l; sum2 += l * l;
      if (colors.size < 5000) colors.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4));
    }
    const n = d.length / 4, mean = sum / n;
    return { mean: +mean.toFixed(1), stddev: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1), colors: colors.size };
  }, buf.toString('base64'));
}

function makeT({ page, viewportName, shotDir, milestone, origin, results, test }) {
  const t = {
    page,
    viewport: viewportName,
    vp: VIEWPORTS[viewportName],
    origin,
    milestone,
    shotDir,
    shots: [],
    async game(method, ...args) {
      return page.evaluate(([m, a]) => {
        const g = window.__game;
        if (!g) throw new Error('window.__game is not defined');
        if (typeof g[m] !== 'function') throw new Error('window.__game.' + m + ' is not a function');
        return g[m](...a);
      }, [method, args]);
    },
    state() { return t.game('getState'); },
    seed(n) { return t.game('seed', n); },
    // Wait for two animation frames, then for __game.isIdle() if the game provides it.
    async waitForStable(timeout = 5000) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const idle = await page.evaluate(() => !window.__game || typeof window.__game.isIdle !== 'function' || !!window.__game.isIdle());
        if (idle) return true;
        await page.waitForTimeout(50);
      }
      return false;
    },
    waitIdle(timeout) { return t.waitForStable(timeout); },
    // Wait for finite CSS animations and transitions (a fading toast, a sliding dialog) to finish.
    // Infinite ones (a pulsing button) are ignored. isIdle() can't see these.
    async waitForAnimations(timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const busy = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running'
          && a.effect && a.effect.getComputedTiming().iterations !== Infinity).length);
        if (!busy) return true;
        await page.waitForTimeout(50);
      }
      return false;
    },
    // Let the game loop run n animation frames (camera settling after a setState, etc.).
    async waitFrames(n = 2) {
      await page.evaluate((n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); f(); }), n);
    },
    // Step a paused game in chunks until pred(state) holds; runs in the page, so pred must be self-contained.
    async stepUntil(pred, { max = 3600, chunk = 15, label = 'condition' } = {}) {
      const r = await page.evaluate(([src, max, chunk]) => {
        const g = window.__game, pred = new Function('return (' + src + ')')();
        let s = g.getState(), ok = !!pred(s);
        for (let k = 0; k < max && !ok; k += chunk) { const out = g.step(chunk); s = out && typeof out === 'object' ? out : g.getState(); ok = !!pred(s); }
        return { s, ok };
      }, [pred.toString(), max, chunk]);
      if (!r.ok) t.fail(`stepUntil timed out after ${max} ticks: ${label}`);
      return r.s;
    },
    // Reload the page and wait for window.__game again (localStorage and init scripts persist).
    async reload() {
      const started = Date.now();
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 10000 });
      return Date.now() - started;
    },
    // Real touch drag via CDP (page.mouse does not produce touch pointer events under hasTouch).
    // holdMs waits after touchStart; holdEndMs keeps the finger down at `to` before lifting (held stick, cast).
    async touchDrag(from, to, { steps = 12, holdMs = 0, holdEndMs = 0 } = {}) {
      const cdp = await page.context().newCDPSession(page);
      const pt = ([x, y]) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
      if (holdMs) await page.waitForTimeout(holdMs);
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]) });
      }
      if (holdEndMs) await page.waitForTimeout(holdEndMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
    // Single tap via CDP touch events.
    async tap([x, y]) { await t.touchDrag([x, y], [x, y], { steps: 1 }); },
    // Save a screenshot and sanity-check it is not blank. Returns { file, stats }.
    // wait: false captures immediately (mid-animation frames) instead of waiting for isIdle().
    // timeout: how long to wait for isIdle() (default 5 s; raise it for software-rendered 3D).
    // animations: true also waits for finite CSS animations and transitions.
    async shot(name, { fullPage = false, allowBlank = false, wait = true, timeout = 5000, animations = false } = {}) {
      if (wait) await t.waitForStable(timeout);
      if (wait && animations) await t.waitForAnimations(timeout);
      fs.mkdirSync(shotDir, { recursive: true });
      const safe = name.replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase();
      const file = path.join(shotDir, safe + '.png');
      const buf = await page.screenshot({ path: file, fullPage });
      const stats = await imageStats(page, buf);
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      t.shots.push({ name: safe, file: rel, stats });
      if (!allowBlank && (stats.stddev < 2 || stats.colors < 3)) t.fail(`screenshot "${name}" looks blank (stddev ${stats.stddev}, colors ${stats.colors})`);
      return { file: rel, stats };
    },
    // Layout checks: horizontal overflow and interactive elements outside the viewport.
    async checkLayout({ allowScrollY = true } = {}) {
      const r = await page.evaluate(() => {
        const de = document.documentElement;
        const issues = [];
        if (de.scrollWidth > innerWidth + 1) issues.push(`horizontal overflow: scrollWidth ${de.scrollWidth} > ${innerWidth}`);
        for (const el of document.querySelectorAll('button, a[href], input, select, [role=button]')) {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (b.width === 0 || b.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
          if (b.right < 0 || b.left > innerWidth + 1 || b.right > innerWidth + 1)
            issues.push(`control off-screen horizontally: ${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
        }
        return { issues, scrollHeight: de.scrollHeight, innerHeight };
      });
      if (!allowScrollY && r.scrollHeight > r.innerHeight + 1) r.issues.push(`vertical overflow: ${r.scrollHeight} > ${r.innerHeight}`);
      for (const i of r.issues) t.fail('layout: ' + i);
      return r;
    },
    // Average frames per second over `ms` milliseconds.
    async fps(ms = 2000) {
      return page.evaluate((dur) => new Promise((res) => {
        let frames = 0; const start = performance.now();
        const tick = (now) => { frames++; if (now - start < dur) requestAnimationFrame(tick); else res(+(frames * 1000 / (now - start)).toFixed(1)); };
        requestAnimationFrame(tick);
      }), ms);
    },
    // Main-thread cost per frame over `ms`, from CDP Performance metrics in thread CPU time, so it holds
    // steady while other browsers load the machine (rAF fps does not). Returns ms per frame:
    // { frames, fps, taskMs, scriptMs, layoutMs, styleMs }. The budget for 60 fps is taskMs well under 16.7.
    async frameCost(ms = 2000) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }).catch(() => cdp.send('Performance.enable'));
      const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const a = await get();
      const { frames, wall } = await page.evaluate((dur) => new Promise((res) => {
        let frames = 0; const start = performance.now();
        const tick = (now) => { frames++; if (now - start < dur) requestAnimationFrame(tick); else res({ frames, wall: now - start }); };
        requestAnimationFrame(tick);
      }), ms);
      const b = await get();
      await cdp.send('Performance.disable').catch(() => {});
      await cdp.detach();
      const per = (k) => +(((b[k] || 0) - (a[k] || 0)) * 1000 / Math.max(1, frames)).toFixed(2);
      return { frames, fps: +(frames * 1000 / wall).toFixed(1), taskMs: per('TaskDuration'), scriptMs: per('ScriptDuration'),
        layoutMs: per('LayoutDuration'), styleMs: per('RecalcStyleDuration') };
    },
    // Slow the page's CPU by `rate`× (CDP Emulation), e.g. 4 for a mid-range phone; 1 turns it off.
    async cpuThrottle(rate = 4) {
      t._throttle = t._throttle || await page.context().newCDPSession(page);
      await t._throttle.send('Emulation.setCPUThrottlingRate', { rate });
    },
    // WCAG contrast of visible text: { checked, fails: ['tag#id.class "text" ratio'] }. Options: selector,
    // min (4.5), largeMin (3), fallbackBg ([r,g,b]), skip (a selector to leave out). fail: true fails the test.
    async contrastReport({ fail = false, ...opts } = {}) {
      const r = await page.evaluate(contrastInPage, opts);
      if (fail) for (const f of r.fails) t.fail('contrast: ' + f);
      return r;
    },
    async memoryMB() {
      return page.evaluate(() => (performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null));
    },
    expect(cond, msg) { if (!cond) t.fail(msg || 'expectation failed'); },
    equal(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) t.fail(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); },
    fail(msg) { results.failures.push(`[${viewportName}] ${test.name}: ${msg}`); },
    log(...a) { results.logs.push(`[${viewportName}] ${test.name}: ${a.join(' ')}`); },
  };
  return t;
}

// Plain Node checks (`node: true`): no browser, only the assertion half of `t`.
async function runNodeTest(test, milestone) {
  const results = { failures: [], logs: [] };
  const t = {
    viewport: 'node', milestone, shots: [],
    expect(cond, msg) { if (!cond) t.fail(msg || 'expectation failed'); },
    equal(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) t.fail(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); },
    fail(msg) { results.failures.push(`[node] ${test.name}: ${msg}`); },
    log(...a) { results.logs.push(`[node] ${test.name}: ${a.join(' ')}`); },
  };
  try { await test.run(t); } catch (e) { t.fail('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  return results;
}

export async function runSuite({ gameDir, testDir, milestone = 'latest', viewport = 'both', only = null, file = null, headed = false, gallery = true,
  gpu = false, uncapped = false, fileUrl = false, slow = false, clean = false, browser: engine = 'chromium' }) {
  let tests = await loadTests(testDir, only, file);
  if (engine !== 'chromium') {
    tests = tests.filter((x) => !x.node && (x.browsers || ['chromium']).includes(engine));
    milestone = `${milestone}-${engine}`;
  }
  if (!tests.length) { console.error(`no tests found in ${testDir}`); return { ok: false }; }
  // Slow tests (long balance sims) run only when asked for, or at the final milestone.
  const runSlow = slow || milestone === 'final';
  const skipped = tests.filter((x) => x.slow && !runSlow);
  tests = tests.filter((x) => !x.slow || runSlow);
  if (skipped.length) console.log(`skipping ${skipped.length} slow test(s); add --slow to run them`);

  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const relGame = path.relative(ROOT, gameDir).replace(/\\/g, '/');
  const launchArgs = gpu && engine === 'chromium' ? [...GPU_ARGS, ...(uncapped ? UNCAPPED_ARGS : [])] : [];
  const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: !headed, args: launchArgs });
  if (gpu) console.log('gpu: Chromium launched with ' + launchArgs.join(' '));
  if (engine !== 'chromium') console.log(`${engine}: ${tests.length} test(s) opted in`);
  const vps = (viewport === 'both' ? ['desktop', 'mobile'] : [viewport]).filter((v) => engine !== 'firefox' || v === 'desktop');
  const repDir = path.join(gameDir, 'screenshots', milestone);
  if (clean && !only && !file) {
    // Delete files, not folders: a Windows shell sitting in a folder locks it (EBUSY).
    for (const vp of vps) {
      const dir = path.join(repDir, vp);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* locked or a folder */ } }
    }
  }
  const report = { game: relGame, milestone, started: new Date().toISOString(), gpu, uncapped, fileUrl, tests: [] };
  let failed = 0;

  for (const test of tests) {
    if (test.node) {
      const started = Date.now();
      const results = await runNodeTest(test, milestone);
      const pass = results.failures.length === 0;
      if (!pass) failed++;
      report.tests.push({ name: test.name, file: test.file, viewport: 'node', pass, ms: Date.now() - started, failures: results.failures, logs: results.logs, shots: [] });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [node] ${test.name}  (${Date.now() - started} ms)`);
      for (const f of results.failures) console.log('      ✗ ' + f);
      for (const l of results.logs) console.log('      · ' + l);
      continue;
    }
    for (const vpName of (test.viewports || ['desktop', 'mobile']).filter((v) => vps.includes(v))) {
      const results = { failures: [], logs: [], consoleErrors: [], external: [] };
      // file:// mode loads the game exactly as a player opening index.html from disk would (tainted canvases,
      // no fetch of local files, no ES-module imports). Only the game's own folder may be read.
      const asFile = fileUrl || !!test.fileUrl;
      const gameFileUrl = pathToFileURL(gameDir).href + '/';
      const { width, height, ...device } = VIEWPORTS[vpName];
      const context = await browser.newContext({ viewport: { width, height }, ...device, reducedMotion: test.reducedMotion ? 'reduce' : 'no-preference', colorScheme: test.colorScheme || 'light' });
      await context.addInitScript(() => { window.__TEST__ = true; });
      if (test.initScript) await context.addInitScript(test.initScript);
      // Games must be self-contained: block and record any request that leaves the local server.
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:') || (asFile && u.startsWith(gameFileUrl))) return route.continue();
        results.external.push(u);
        return route.abort();
      });
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => results.consoleErrors.push('pageerror: ' + e.message));

      const shotDir = path.join(gameDir, 'screenshots', milestone, vpName);
      const t = makeT({ page, viewportName: vpName, shotDir, milestone, origin, results, test });
      t.fileUrl = asFile;
      t.engine = engine;
      t.uncapped = gpu && uncapped;
      t.browser = browser;
      t.gpu = gpu;
      const rel = test.url || 'index.html';
      const q = rel.search(/[?#]/);
      const url = asFile ? pathToFileURL(path.join(gameDir, q < 0 ? rel : rel.slice(0, q))).href + (q < 0 ? '' : rel.slice(q))
        : `${origin}/${relGame ? relGame + '/' : ''}${rel}`;
      const started = Date.now();
      try {
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.__game, null, { timeout: 10000 }).catch(() => t.fail('window.__game test hooks never appeared'));
        t.loadMs = Date.now() - started;
        await test.run(t);
      } catch (e) {
        t.fail('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
      }
      if (!test.allowConsoleErrors) for (const c of results.consoleErrors) t.fail('console error: ' + c);
      for (const u of results.external) t.fail('external request blocked: ' + u);
      await context.close();

      const pass = results.failures.length === 0;
      if (!pass) failed++;
      report.tests.push({ name: test.name, file: test.file, viewport: vpName, pass, ms: Date.now() - started, failures: results.failures, logs: results.logs, shots: t.shots });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${vpName}] ${test.name}  (${Date.now() - started} ms, ${t.shots.length} shots)`);
      for (const f of results.failures) console.log('      ✗ ' + f);
      for (const l of results.logs) console.log('      · ' + l);
    }
  }

  await browser.close();
  server.close();
  report.finished = new Date().toISOString();
  report.passed = report.tests.length - failed;
  report.failed = failed;
  fs.mkdirSync(repDir, { recursive: true });
  const repFile = path.join(repDir, 'report.json');
  let saved = report;
  // A filtered run (--only, --file, one viewport) merges into the milestone's report instead of replacing it.
  // `lastRun` names the tests this run touched; `passed`/`failed` count the merged whole.
  if ((only || file || viewport !== 'both') && fs.existsSync(repFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(repFile, 'utf8'));
      const key = (x) => x.name + '\u0000' + x.viewport;
      const fresh = new Set(report.tests.map(key));
      saved = { ...report, tests: [...(prev.tests || []).filter((x) => !fresh.has(key(x))), ...report.tests],
        lastRun: report.tests.map((x) => ({ name: x.name, viewport: x.viewport, pass: x.pass })) };
      saved.failed = saved.tests.filter((x) => !x.pass).length;
      saved.passed = saved.tests.length - saved.failed;
    } catch { /* unreadable old report: replace it */ }
  }
  fs.writeFileSync(repFile, JSON.stringify(saved, null, 2));
  if (gallery) writeGallery(gameDir);
  console.log(`\n${report.passed}/${report.tests.length} passed · screenshots in ${path.relative(ROOT, repDir)}`);
  return { ok: failed === 0, report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const gameDir = a.target === 'smoke' ? path.join(HERE, 'smoke') : path.resolve(ROOT, a.target);
  const { ok } = await runSuite({ gameDir, testDir: path.join(gameDir, 'tests'), milestone: a.milestone, viewport: a.viewport, only: a.only, file: a.file, headed: a.headed, gallery: a.gallery,
    gpu: a.gpu, uncapped: a.uncapped, fileUrl: a.fileUrl, slow: a.slow, clean: a.clean, browser: a.browser });
  process.exit(ok ? 0 : 1);
}
