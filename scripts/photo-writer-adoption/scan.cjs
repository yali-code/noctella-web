'use strict';
// Shared filesystem/child-process mutation scanner for the writer census (apps/api/src, incl. src/scripts).
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../apps/api/src');
const FS_MODULE = /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(["'](?:node:)?fs(?:\/promises)?["']\)/;
const CHILD_MODULE = /from\s+["'](?:node:)?child_process["']|require\(["'](?:node:)?child_process["']\)/;
// Always-mutating fs API names (unambiguous even unqualified).
const MUTATION = /\b(writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|copyFile|cpSync|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|linkSync|link|symlinkSync|symlink|createWriteStream|mkdtempSync|mkdtemp|toFile|chmodSync|chmod)\s*\(/g;
// Ambiguous names (string helpers named truncate, etc.): counted only when fs-qualified or imported from fs.
const AMBIGUOUS = ['cp', 'rmdir', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync'];
const OPEN_FOR_WRITE = /\bopen(Sync)?\([^)\n]*["'](w|wx|w\+|a|a\+|r\+)["']/g;
// OPEN_FOR_WRITE also matches quoted flags inside an options object ({ flags: "wx" }).
const HANDLE_WRITE = /\.\s*(write|writeFile|appendFile|truncate)\s*\(/g;
const CHILD = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fsImportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  return names;
}

function scanText(text) {
  const t = stripComments(text);
  const imported = fsImportedNames(t);
  let ambiguous = 0;
  for (const name of AMBIGUOUS) {
    ambiguous += (t.match(new RegExp(`\\b(?:fs|fsp|fsPromises|promises)\\.${name}\\s*\\(`, 'g')) ?? []).length;
    if (imported.has(name)) ambiguous += (t.match(new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g')) ?? []).length;
  }
  const usesFs = FS_MODULE.test(t);
  const opensFiles = usesFs && /\bopen(Sync)?\s*\(/.test(t);
  return {
    mutation: (t.match(MUTATION) ?? []).length + (t.match(OPEN_FOR_WRITE) ?? []).length + ambiguous,
    handle: opensFiles ? (t.match(HANDLE_WRITE) ?? []).length : 0,
    child: CHILD_MODULE.test(t) ? (t.match(CHILD) ?? []).length : 0,
  };
}

function sources(root = SRC) {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f); } };
  walk(root);
  return files;
}
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

function census() {
  const out = {};
  for (const file of sources()) {
    const counts = scanText(fs.readFileSync(file, 'utf8'));
    if (counts.mutation || counts.handle || counts.child) out[rel(file)] = counts;
  }
  return out;
}

module.exports = { SRC, census, scanText, sources, rel, stripComments };
if (require.main === module) console.log(JSON.stringify(census(), null, 1));
