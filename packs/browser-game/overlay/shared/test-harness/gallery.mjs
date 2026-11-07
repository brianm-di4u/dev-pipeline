#!/usr/bin/env node
// Writes games/<slug>/screenshots/index.html: every screenshot grouped by milestone and viewport,
// with pass/fail status from each milestone's report.json.
//   node shared/test-harness/gallery.mjs games/<slug>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function writeGallery(gameDir) {
  const shotsDir = path.join(gameDir, 'screenshots');
  if (!fs.existsSync(shotsDir)) return null;
  const milestones = fs.readdirSync(shotsDir).filter((d) => fs.statSync(path.join(shotsDir, d)).isDirectory()).sort();
  let body = '';
  for (const m of milestones) {
    const repFile = path.join(shotsDir, m, 'report.json');
    const rep = fs.existsSync(repFile) ? JSON.parse(fs.readFileSync(repFile, 'utf8')) : null;
    const failing = rep ? rep.tests.filter((t) => !t.pass) : [];
    body += `<section><h2>${esc(m)} ${rep ? `<span class="${rep.failed ? 'bad' : 'ok'}">${rep.passed}/${rep.tests.length} passed</span> <small>${esc(rep.finished || '')}</small>` : ''}</h2>`;
    if (failing.length) body += '<ul class="fails">' + failing.flatMap((t) => t.failures).map((f) => `<li>${esc(f)}</li>`).join('') + '</ul>';
    for (const vp of ['desktop', 'mobile']) {
      const dir = path.join(shotsDir, m, vp);
      if (!fs.existsSync(dir)) continue;
      const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      body += `<h3>${vp} · ${pngs.length}</h3><div class="grid ${vp}">`;
      for (const p of pngs) body += `<figure><a href="${m}/${vp}/${p}"><img loading="lazy" src="${m}/${vp}/${p}" alt="${esc(p)}"></a><figcaption>${esc(p.replace(/\.png$/, ''))}</figcaption></figure>`;
      body += '</div>';
    }
    body += '</section>';
  }
  const title = path.basename(gameDir) + ' screenshots';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f3ee;--fg:#1f2a2e;--muted:#5d6b70;--card:#fff;--ok:#1d7a4f;--bad:#b3261e;--line:#ddd5c8}
@media (prefers-color-scheme:dark){:root{--bg:#141a1c;--fg:#e8e4dc;--muted:#9aa6aa;--card:#1e2629;--line:#2e3a3e;--ok:#5fd39a;--bad:#ff8a80}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{margin:0 0 8px}h2{border-top:1px solid var(--line);padding-top:16px}small{color:var(--muted);font-weight:normal}
.ok{color:var(--ok)}.bad{color:var(--bad)}.fails{color:var(--bad)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}.grid.mobile{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
img{display:block;width:100%;height:auto}figcaption{padding:6px 8px;color:var(--muted);word-break:break-all}
</style></head><body><h1>${esc(title)}</h1>${body || '<p>No screenshots yet.</p>'}</body></html>`;
  fs.writeFileSync(path.join(shotsDir, 'index.html'), html);
  return path.join(shotsDir, 'index.html');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node shared/test-harness/gallery.mjs games/<slug>'); process.exit(2); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  console.log(writeGallery(path.resolve(root, target)) || 'no screenshots folder');
}
