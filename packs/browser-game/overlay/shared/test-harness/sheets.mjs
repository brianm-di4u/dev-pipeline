#!/usr/bin/env node
// Contact sheets for fast visual review: tiles a milestone's screenshots into labelled grids.
//
//   node shared/test-harness/sheets.mjs games/<slug> [--milestone final] [--per 6]
//   node shared/test-harness/sheets.mjs games/<slug> --milestone visual-final --compare visual-before
//
// Writes games/<slug>/screenshots/<milestone>/sheets/<viewport>-NN.png (desktop: 2 columns,
// mobile: 4 columns). Each caption is the shot name, plus the test that took it when report.json has it.
// --compare <milestone> instead pairs every shot with the same-named shot of that earlier milestone,
// labelled BEFORE / AFTER, in screenshots/<milestone>/before-after/ (desktop 2 pairs per sheet, mobile 3).
// Open each sheet with the Read tool, then open single shots at full size wherever a detail needs a
// closer look. Sheets are a review aid, not a substitute for that.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const VALUED = ['--milestone', '--per', '--compare'];
const target = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (!target) { console.error('usage: node shared/test-harness/sheets.mjs games/<slug> [--milestone final] [--per 6] [--compare <before-milestone>]'); process.exit(2); }
const gameDir = target === 'smoke' ? path.join(HERE, 'smoke') : path.resolve(ROOT, target);
const milestone = opt('--milestone', 'final');
const compare = opt('--compare', null);
const LAYOUT = compare
  ? { desktop: { cols: 2, cellW: 640, per: 2 }, mobile: { cols: 6, cellW: 260, per: 3 } }
  : { desktop: { cols: 2, cellW: 760, per: 6 }, mobile: { cols: 4, cellW: 360, per: 8 } };

// shot file name → test name, from the milestone's report.json.
function testNames(ms) {
  const map = new Map();
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(gameDir, 'screenshots', ms, 'report.json'), 'utf8'));
    for (const t of rep.tests || []) for (const s of t.shots || []) map.set(`${t.viewport}/${path.basename(s.file)}`, t.name);
  } catch { /* no report: captions show the file name only */ }
  return map;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const uri = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const outDir = path.join(gameDir, 'screenshots', milestone, compare ? 'before-after' : 'sheets');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const names = testNames(milestone);
let written = 0;

for (const [vp, lay] of Object.entries(LAYOUT)) {
  const dir = path.join(gameDir, 'screenshots', milestone, vp);
  const beforeDir = compare && path.join(gameDir, 'screenshots', compare, vp);
  if (!fs.existsSync(dir) || (compare && !fs.existsSync(beforeDir))) continue;
  const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && (!compare || fs.existsSync(path.join(beforeDir, f)))).sort();
  const per = +opt('--per', lay.per);
  for (let i = 0; i < pngs.length; i += per) {
    const group = pngs.slice(i, i + per);
    const caption = (f, tag) => {
      const test = names.get(`${vp}/${f}`);
      return `<figcaption>${tag ? `<b>${tag}</b> ` : ''}${esc(f.replace(/\.png$/, ''))}${test ? ` <i>· ${esc(test)}</i>` : ''}</figcaption>`;
    };
    const cells = group.map((f) => compare
      ? `<figure><img src="${uri(path.join(beforeDir, f))}">${caption(f, 'BEFORE')}</figure><figure><img src="${uri(path.join(dir, f))}">${caption(f, 'AFTER')}</figure>`
      : `<figure><img src="${uri(path.join(dir, f))}">${caption(f)}</figure>`).join('');
    await page.setContent(`<!doctype html><style>
      body{margin:0;background:#222;font:600 15px system-ui,sans-serif;color:#fff}
      main{display:grid;grid-template-columns:repeat(${lay.cols},${lay.cellW}px);gap:8px;padding:8px;width:max-content}
      figure{margin:0;background:#000}img{display:block;width:100%}
      figcaption{padding:4px 6px;background:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      figcaption i{font-weight:400;color:#bbb}
    </style><main>${cells}</main>`);
    await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode())));
    const file = path.join(outDir, `${vp}-${String(i / per + 1).padStart(2, '0')}.png`);
    await page.locator('main').screenshot({ path: file });
    written++;
  }
}
await browser.close();
console.log(`${written} ${compare ? 'before/after ' : ''}sheets in ${path.relative(ROOT, outDir)}`);
