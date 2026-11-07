#!/usr/bin/env node
// Packs generated art into compact WebP game assets, using the harness's own Chromium (no image libs).
//
//   node shared/test-harness/art-pack.mjs games/<slug> [--only name1,name2]
//
// Reads games/<slug>/art-src/art.json:
//   { "quality": 0.82, "items": [ { "name": "court-qh", "src": "court-qh.png", "w": 420, "h": 588,
//       "fit": "cover"|"contain", "crop": [x, y, w, h] (0..1, optional), "keyWhite": 0..60 (optional),
//       "quality": 0.85 (optional) } ] }
// Writes games/<slug>/assets/<name>.webp, games/<slug>/assets/manifest.json and a review contact
// sheet at games/<slug>/art-src/sheet.png (open it with the Read tool).
// keyWhite turns near-white background connected to the image edge into transparency (for motifs
// generated on flat white); the value is the per-channel tolerance below 255.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1].split(',') : null; })();
if (!target) { console.error('usage: node shared/test-harness/art-pack.mjs games/<slug> [--only a,b]'); process.exit(2); }

const gameDir = path.resolve(ROOT, target);
const srcDir = path.join(gameDir, 'art-src');
const outDir = path.join(gameDir, 'assets');
const spec = JSON.parse(fs.readFileSync(path.join(srcDir, 'art.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const manPath = path.join(outDir, 'manifest.json');
const manifest = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : {};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
let failed = 0;
for (const it of spec.items) {
  if (only && !only.includes(it.name)) continue;
  const file = path.join(srcDir, it.src);
  if (!fs.existsSync(file)) { console.log(`  missing  ${it.name} (${it.src})`); failed++; continue; }
  const url = `data:${MIME[path.extname(file).toLowerCase()] || 'image/png'};base64,` + fs.readFileSync(file).toString('base64');
  const b64 = await page.evaluate(async ({ url, it, q }) => {
    const img = new Image(); img.src = url; await img.decode();
    const [cx, cy, cw, chh] = it.crop || [0, 0, 1, 1];
    let sx = cx * img.naturalWidth, sy = cy * img.naturalHeight, sw = cw * img.naturalWidth, sh = chh * img.naturalHeight;
    let src = document.createElement('canvas'); src.width = Math.round(sw); src.height = Math.round(sh);
    src.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, src.width, src.height);
    if (it.keyWhite) {
      // Flood-fill from the border through near-white pixels, then feather the alpha edge.
      const g = src.getContext('2d'), W = src.width, H = src.height, d = g.getImageData(0, 0, W, H), p = d.data;
      const lim = 255 - it.keyWhite, seen = new Uint8Array(W * H), stack = [];
      const white = (i) => p[i * 4] >= lim && p[i * 4 + 1] >= lim && p[i * 4 + 2] >= lim;
      for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
      for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
      while (stack.length) {
        const i = stack.pop(); if (seen[i] || !white(i)) continue; seen[i] = 1;
        const x = i % W, y = (i / W) | 0;
        if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W);
      }
      for (let i = 0; i < W * H; i++) {
        if (seen[i]) { p[i * 4 + 3] = 0; continue; }
        const x = i % W, y = (i / W) | 0;
        const edge = (x > 0 && seen[i - 1]) || (x < W - 1 && seen[i + 1]) || (y > 0 && seen[i - W]) || (y < H - 1 && seen[i + W]);
        if (edge) { const m = Math.min(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]); p[i * 4 + 3] = Math.min(255, Math.round((255 - m) * 255 / (255 - lim + 1))); }
      }
      g.putImageData(d, 0, 0);
    }
    if (it.trim) {
      // Crop to the visible (alpha > 8) bounding box so every motif fills its box the same way.
      const g = src.getContext('2d'), W = src.width, H = src.height, p = g.getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (p[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 > x0 && y1 > y0) {
        const c = document.createElement('canvas'); c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
        c.getContext('2d').drawImage(src, -x0, -y0); src = c;
      }
    }
    // Fit, then halve repeatedly so the final resample is never more than 2:1 (sharper than one big step).
    const W = it.w, H = it.h, fit = it.fit || 'cover';
    const s = fit === 'cover' ? Math.max(W / src.width, H / src.height) : Math.min(W / src.width, H / src.height);
    const targetW = src.width * s;
    while (src.width / 2 >= targetW) {
      const c = document.createElement('canvas'); c.width = Math.ceil(src.width / 2); c.height = Math.ceil(src.height / 2);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height); src = c;
    }
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d'); g.imageSmoothingQuality = 'high';
    const k = fit === 'cover' ? Math.max(W / src.width, H / src.height) : Math.min(W / src.width, H / src.height);
    const dw = src.width * k, dh = src.height * k;
    g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return out.toDataURL('image/webp', q).split(',')[1];
  }, { url, it, q: it.quality || spec.quality || 0.82 });
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(outDir, it.name + '.webp'), buf);
  manifest[it.name] = { file: it.name + '.webp', w: it.w, h: it.h, bytes: buf.length };
  console.log(`  packed   ${it.name.padEnd(22)} ${it.w}x${it.h}  ${(buf.length / 1024).toFixed(1)} KB`);
}
// Drop entries whose items were removed from the spec.
for (const k of Object.keys(manifest)) if (!spec.items.some((i) => i.name === k)) delete manifest[k];
fs.writeFileSync(manPath, JSON.stringify(manifest, null, 1) + '\n');
const total = Object.values(manifest).reduce((a, m) => a + m.bytes, 0);
console.log(`  total    ${Object.keys(manifest).length} assets, ${(total / 1024 / 1024).toFixed(2)} MB`);

// Contact sheet: every packed asset on a checkerboard, labelled.
const names = Object.keys(manifest).sort();
const cells = names.map((n) => ({ n, url: 'data:image/webp;base64,' + fs.readFileSync(path.join(outDir, manifest[n].file)).toString('base64') }));
const sheet = await page.evaluate(async (cells) => {
  const cw = 200, chh = 230, cols = Math.min(6, Math.max(1, cells.length)), rows = Math.ceil(cells.length / cols);
  const c = document.createElement('canvas'); c.width = cols * cw; c.height = Math.max(1, rows) * chh;
  const g = c.getContext('2d');
  for (let y = 0; y < c.height; y += 10) for (let x = 0; x < c.width; x += 10) { g.fillStyle = ((x + y) / 10) % 2 ? '#d8d8d8' : '#f2f2f2'; g.fillRect(x, y, 10, 10); }
  for (let i = 0; i < cells.length; i++) {
    const img = new Image(); img.src = cells[i].url; await img.decode();
    const x = (i % cols) * cw, y = Math.floor(i / cols) * chh, k = Math.min(190 / img.width, 200 / img.height);
    g.drawImage(img, x + (cw - img.width * k) / 2, y + 5 + (200 - img.height * k) / 2, img.width * k, img.height * k);
    g.fillStyle = '#111'; g.font = '13px system-ui'; g.fillText(cells[i].n, x + 6, y + 222);
  }
  return c.toDataURL('image/png').split(',')[1];
}, cells);
fs.writeFileSync(path.join(srcDir, 'sheet.png'), Buffer.from(sheet, 'base64'));
await browser.close();
process.exit(failed ? 1 : 0);
