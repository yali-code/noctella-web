'use strict';
// P2-2B3D4 (#407/#396): filesystem-mutation census guard for the 14-writer adoption matrix.
// Fails when a mutation call site is added, moved or removed anywhere in apps/api/src, so the
// readiness matrix in docs/engineering/P2-2B3D4_WRITER_ADOPTION.md cannot silently go stale, and
// when application code imports a development-only photo capability.
// Run: node --test scripts/photo-writer-adoption/census.test.cjs   (no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../apps/api/src');
// fs mutation APIs (string helpers named `truncate` exist in non-fs code; fs.truncate is unused).
const MUTATION = /\b(writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|copyFile|cpSync|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|linkSync|link|symlinkSync|symlink|createWriteStream|mkdtempSync|mkdtemp|toFile|chmodSync|chmod)\s*\(/g;
const OPEN_FOR_WRITE = /\bopen(Sync)?\([^)\n]*["'](w|wx|w\+|a|a\+|r\+)["']/g;

/** file -> expected call-site count and the matrix writer IDs (see the adoption document). */
const EXPECTED = {
  'routes/productPhotoUpload.ts': { sites: 2, writers: ['W2'] },
  'services/stagedProductPhotoStorage.ts': { sites: 4, writers: ['W2', 'W10'] },
  'services/photoStorage.ts': { sites: 4, writers: ['W1', 'W4', 'W10'] },
  'services/aiIntakePhotoStorage.ts': { sites: 3, writers: ['W3', 'W5'] },
  'services/managedFileDeletion.ts': { sites: 1, writers: ['W5', 'W6'] },
  'services/productPhotoStorageWorkflow.ts': { sites: 2, writers: ['W7', 'W8', 'W9'] },
  'integrations/instagram/mediaPreparation.ts': { sites: 3, writers: ['W11'] },
  'integrations/media/reelRenderer.ts': { sites: 3, writers: ['W12'] },
  'use-cases/product-photo-backup/useCases.ts': { sites: 5, writers: ['W13'] },
  'repositories/product-photo-backup/s3Compatible.ts': { sites: 2, writers: ['W13'] },
  'use-cases/database-backup/useCases.ts': { sites: 7, writers: ['W14'] },
  'repositories/database-backup/s3Compatible.ts': { sites: 2, writers: ['W14'] },
  'services/developmentPhotoStorageCapability.ts': { sites: 6, writers: ['DEV'] },
  'services/developmentPhotoDiskBudget.ts': { sites: 4, writers: ['DEV'] },
  'services/developmentPhotoRecovery.ts': { sites: 1, writers: ['DEV'] },
  // P2-2B3D6: gate epochs/lease markers/lock only (bookkeeping, never media).
  'services/developmentLegacyWriterGate.ts': { sites: 4, writers: ['DEV'] },
};
const DEV_MODULES = ['developmentPhotoStorageCapability', 'developmentPhotoDiskBudget', 'developmentPhotoRecovery', 'developmentLegacyWriterGate'];

function sources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'scripts') walk(file); continue; }
      if (file.endsWith('.ts')) files.push(file);
    }
  };
  walk(SRC);
  return files;
}
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('every filesystem mutation call site in apps/api/src is in the 14-writer matrix', () => {
  const actual = {};
  for (const file of sources()) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const sites = (text.match(MUTATION) ?? []).length + (text.match(OPEN_FOR_WRITE) ?? []).length;
    if (sites) actual[rel(file)] = sites;
  }
  const expected = Object.fromEntries(Object.entries(EXPECTED).map(([file, value]) => [file, value.sites]));
  assert.deepEqual(actual, expected, 'A media/filesystem writer changed: update the adoption matrix before changing this census.');
});

/**
 * #406's explicit private-root producer is the single permitted reference: a type-only import
 * (erased at compile time) and one lazy require that runs only after the NODE_ENV/flag guard.
 * Anything else referencing a development module from application code fails the census.
 */
function allowPrivateRootProducer(text) {
  const lines = text.split(/\r?\n/);
  const typeImport = lines.findIndex((l) => l === 'import type { DevelopmentPrivatePhotoRoot } from "./developmentPhotoStorageCapability";');
  const lazy = lines.findIndex((l) => l.includes('require("./developmentPhotoStorageCapability")'));
  assert.ok(typeImport >= 0 && lazy > 0, 'expected the #406 private-root producer shape');
  assert.match(lines[lazy - 1], /PHOTO_DEVELOPMENT_CAPABILITY_DISABLED/, 'lazy require must directly follow the development guard');
  assert.match(lines[lazy - 2], /export function writeDeterministicProductPhotoInPrivateRoot\(/);
  return lines.filter((_, i) => i !== typeImport && i !== lazy).join('\n');
}

test('development-only photo capabilities are not imported by application code', () => {
  const offenders = [];
  for (const file of sources()) {
    if (DEV_MODULES.some((name) => file.endsWith(`${name}.ts`))) continue;
    let text = fs.readFileSync(file, 'utf8');
    if (rel(file) === 'services/photoStorage.ts') text = allowPrivateRootProducer(text);
    for (const name of DEV_MODULES) if (new RegExp(`from ["'][^"']*${name}["']|require\\(["'][^"']*${name}["']\\)`).test(text)) offenders.push(`${rel(file)} -> ${name}`);
  }
  assert.deepEqual(offenders, []);
});

test('PRODUCT_PHOTO_DISK_STAGING_ENABLED stays disabled unless explicitly "true"', () => {
  const hits = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    // A default-true fallback or assignment (comparisons such as === "true" are fine).
    for (const line of text.split(/\r?\n/)) if (/PRODUCT_PHOTO_DISK_STAGING_ENABLED\s*(\?\?|\|\|)\s*["']true|PRODUCT_PHOTO_DISK_STAGING_ENABLED["']?\s*[:=]\s*["']true/.test(line)) hits.push(`${rel(file)}: ${line.trim()}`);
  }
  assert.deepEqual(hits, [], 'no default-true fallback for the staging flag');
});
