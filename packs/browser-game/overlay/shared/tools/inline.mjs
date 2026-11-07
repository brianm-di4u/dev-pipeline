#!/usr/bin/env node
// Zero-dependency bundler: turns games/<slug>/src/ into one self-contained games/<slug>/index.html.
//
//   node shared/tools/inline.mjs games/<slug> [--watch] [--out other.html]
//
// Input: games/<slug>/src/index.html, a normal HTML page that references local files:
//   <link rel="stylesheet" href="styles/main.css">   → inlined as <style>
//   <script src="js/engine.js"></script>             → inlined as <script>
//   <script type="module" src="js/main.js"></script> → ES modules are bundled: each local `import ... from './x.js'`
//                                                       is resolved, wrapped in a function scope and ordered by dependency.
//   <!-- @inline data/schools.json as SCHOOLS -->     → becomes <script>const SCHOOLS = {...};</script>
// All paths, including @inline ones, resolve relative to src/ (use ../data/x.json for games/<slug>/data/).
// Imports become snapshots (`const { a } = __m3`), not live bindings: export objects you mutate,
// never a `let` you reassign later.
// Output is written to games/<slug>/index.html with a generated-file banner.
// Remote URLs (http:, https:, //) are a build error: games must not load anything from the network.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!target) { console.error('usage: node shared/tools/inline.mjs games/<slug> [--watch] [--out file.html]'); process.exit(2); }
const gameDir = path.resolve(target);
const srcDir = path.join(gameDir, 'src');
const entry = path.join(srcDir, 'index.html');
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(gameDir, 'index.html');

const isRemote = (u) => /^(https?:)?\/\//i.test(u);
// Normalise to LF: in a CRLF source the import rewrite below starts its match between CR and LF and leaves bare CRs.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n?/g, '\n');
// Keep `</script>` and `</style>` inside inlined code from closing the tag early.
const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
const safeStyle = (s) => s.replace(/<\/style/gi, '<\\/style');

function inlineCss(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  return read(file).replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (m, rel) => {
    if (isRemote(rel)) throw new Error(`remote @import not allowed: ${rel} in ${file}`);
    return inlineCss(path.resolve(path.dirname(file), rel), seen);
  });
}

// Skip a '…' / "…" string or a `…${…}…` template starting at code[i]; returns the index just past it.
function skipQuoted(code, i) {
  const q = code[i];
  for (i++; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') { i++; continue; }
    if (c === q) return i + 1;
    if (q === '`' && c === '$' && code[i + 1] === '{') {
      let depth = 1;
      for (i += 2; i < code.length && depth; i++) {
        const d = code[i];
        if (d === '"' || d === "'" || d === '`') { i = skipQuoted(code, i) - 1; continue; }
        if (d === '{') depth++; else if (d === '}') depth--;
      }
      i--;
    }
  }
  return code.length;
}

// The code with strings, templates and comments blanked (newlines kept), for keyword checks.
function blankLiterals(code) {
  let out = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    let end = -1;
    if (c === '"' || c === "'" || c === '`') end = skipQuoted(code, i);
    else if (c === '/' && code[i + 1] === '/') { end = code.indexOf('\n', i); if (end < 0) end = code.length; }
    else if (c === '/' && code[i + 1] === '*') { end = code.indexOf('*/', i + 2); end = end < 0 ? code.length : end + 2; }
    if (end < 0) { out += c; i++; continue; }
    out += code.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

// Names bound by the declarators of `export const|let|var …` starting at code[i]:
//   a = 1, b = 2   { a, b: c, d = 1, ...e } = o   [x, , y] = arr
// Scans to the end of the statement (top-level `;`, or a newline that ASI would end it at).
function declaredNames(code, i, where) {
  const names = [];
  let depth = 0, expectName = true, last = '';
  while (i < code.length) {
    if (expectName) {
      const m = /^\s*([\w$]+|\{[^{}]*\}|\[[^[\]]*\])/.exec(code.slice(i, i + 4000));
      if (!m) throw new Error(`unsupported export declaration in ${where}: ${code.slice(i, i + 60).trim()}`);
      const p = m[1];
      if (p[0] === '{' || p[0] === '[') {
        for (let part of p.slice(1, -1).split(',')) {
          part = part.trim().replace(/^\.\.\./, '').split('=')[0].trim();
          if (p[0] === '{' && part.includes(':')) part = part.split(':')[1].trim();
          if (!part) continue;
          if (!/^[\w$]+$/.test(part)) throw new Error(`unsupported destructuring export in ${where}: ${p}`);
          names.push(part);
        }
      } else names.push(p);
      i += m[0].length; expectName = false; last = 'x';
      continue;
    }
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { i = skipQuoted(code, i); last = 'x'; continue; }
    if (c === '/' && code[i + 1] === '/') { const e = code.indexOf('\n', i); i = e < 0 ? code.length : e; continue; }
    if (c === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ',') expectName = true;
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === '\n') {
      const next = (/\S/.exec(code.slice(i, i + 200)) || [''])[0];
      if (!/[,=+\-*/%&|^<>?:([{.!~]/.test(last) && !/[,.?:+\-*/%&|^=<>]/.test(next)) break;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return names;
}

// Minimal ES module bundler for local relative imports. Supports:
//   import X from './a.js'; import { a, b as c } from './a.js'; import * as ns from './a.js'; import './a.js';
//   export const/let/var a = 1, b = 2; export const { a, b } = o; export function/class name;
//   export { a, b as c }; export default expr;
// Any other `export` form fails the build rather than shipping a stray keyword.
function bundleModules(entryFile) {
  const order = [];
  const ids = new Map();
  const visit = (file, stack = []) => {
    if (ids.has(file)) return;
    if (stack.includes(file)) throw new Error('circular import: ' + [...stack, file].map((f) => path.relative(srcDir, f)).join(' → '));
    const code = read(file);
    const deps = [];
    code.replace(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?/gm, (m, spec) => {
      if (isRemote(spec)) throw new Error(`remote import not allowed: ${spec} in ${file}`);
      if (!spec.startsWith('.')) throw new Error(`bare import not supported (vendor it into src/): ${spec} in ${file}`);
      deps.push(path.resolve(path.dirname(file), spec));
    });
    for (const d of deps) visit(d, [...stack, file]);
    ids.set(file, '__m' + ids.size);
    order.push(file);
  };
  visit(entryFile);

  const parts = [];
  for (const file of order) {
    const id = ids.get(file);
    let code = read(file);
    const exportsList = [];
    code = code.replace(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (m, what, spec) => {
      const dep = ids.get(path.resolve(path.dirname(file), spec));
      const out = [];
      what = what.trim();
      const ns = what.match(/^\*\s+as\s+([\w$]+)$/);
      if (ns) return `const ${ns[1]} = ${dep};`;
      const def = what.match(/^([\w$]+)\s*(?:,\s*(\{[\s\S]*\}))?$/);
      let named = what.startsWith('{') ? what : null;
      if (def) { out.push(`const ${def[1]} = ${dep}.default;`); named = def[2] || null; }
      if (named) {
        const specs = named.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); });
        out.push(`const { ${specs.join(', ')} } = ${dep};`);
      }
      return out.join(' ');
    });
    code = code.replace(/^\s*import\s+['"]([^'"]+)['"]\s*;?/gm, '');
    code = code.replace(/^(\s*)export\s+default\s+/m, (m, ws) => { exportsList.push('default: __default'); return `${ws}const __default = `; });
    const where = path.relative(srcDir, file);
    code = code.replace(/^(\s*)export\s+(const|let|var)(?=[\s{[])/gm, (m, ws, kw, off, all) => {
      exportsList.push(...declaredNames(all, off + m.length, where));
      return `${ws}${kw}`;
    });
    code = code.replace(/^(\s*)export\s+(function\s*\*?|async\s+function\s*\*?|class)\s*([\w$]+)/gm, (m, ws, kw, name) => { exportsList.push(name); return `${ws}${kw.trim()} ${name}`; });
    code = code.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (m, list) => {
      for (const s of list.split(',').map((x) => x.trim()).filter(Boolean)) {
        const [a, b] = s.split(/\s+as\s+/);
        exportsList.push(b ? `${b.trim()}: ${a.trim()}` : a.trim());
      }
      return '';
    });
    const stray = /^[ \t]*export\b.*$/m.exec(blankLiterals(code));
    if (stray) {
      const line = code.slice(0, stray.index).split('\n').length;
      throw new Error(`unsupported export form in ${where} (bundled line ${line}): ${stray[0].trim().slice(0, 80)}`);
    }
    parts.push(`// ── ${path.relative(srcDir, file).replace(/\\/g, '/')}\nconst ${id} = (() => {\n${code}\nreturn { ${exportsList.join(', ')} };\n})();`);
  }
  return parts.join('\n\n');
}

function build() {
  let html = read(entry);
  html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) return tag;
    if (isRemote(href)) throw new Error('remote stylesheet not allowed: ' + href);
    return `<style>\n${safeStyle(inlineCss(path.resolve(srcDir, href)))}\n</style>`;
  });
  html = html.replace(/<script\s+([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, pre, src, post) => {
    if (isRemote(src)) throw new Error('remote script not allowed: ' + src);
    const file = path.resolve(srcDir, src);
    if (/type=["']module["']/i.test(pre + post)) return `<script>\n"use strict";\n${safeScript(bundleModules(file))}\n</script>`;
    return `<script>\n${safeScript(read(file))}\n</script>`;
  });
  html = html.replace(/<!--\s*@inline\s+(\S+)\s+as\s+(\w+)\s*-->/g, (m, rel, name) => {
    const file = path.resolve(srcDir, rel);
    const raw = read(file);
    const value = rel.endsWith('.json') ? JSON.stringify(JSON.parse(raw)) : JSON.stringify(raw);
    return `<script>const ${name} = ${safeScript(value)};</script>`;
  });
  const banner = `<!-- GENERATED by shared/tools/inline.mjs from src/ – edit src/, not this file. ${new Date().toISOString()} -->\n`;
  html = html.replace(/^(<!doctype html>)/i, `$1\n${banner}`);
  fs.writeFileSync(outFile, html);
  console.log(`built ${path.relative(process.cwd(), outFile)} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

build();
if (args.includes('--watch')) {
  let timer = null;
  fs.watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { build(); } catch (e) { console.error('build failed:', e.message); } }, 100);
  });
  console.log('watching ' + path.relative(process.cwd(), srcDir));
}
