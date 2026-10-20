'use strict';
// P2-2B3D4 (#407/#396), hardened: filesystem and child-process mutation census for the 14-writer
// adoption matrix (docs/engineering/P2-2B3D4_WRITER_ADOPTION.md and the release readiness docs).
// Counts per file and category, including fs-qualified/imported cp/rmdir/truncate, object-style open
// flags, FileHandle writes, child-process launches and application scripts under src/scripts.
// Run: node --test scripts/photo-writer-adoption/census.test.cjs   (no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { census, scanText, sources, rel } = require('./scan.cjs');

/** file -> expected counts per category, and what the file is in the writer matrix. */
const EXPECTED = {
  'services/photoPersistentIdentity.ts': { child: 2, writers: ['W2/W4 read-only descriptor UUID evidence; invokes reviewed launcher, no filesystem mutation'] },

  'routes/productPhotoUpload.ts': { mutation: 2, writers: ['W2'] },
  'services/photoOperationAuthority.ts': { mutation: 1, writers: ['W2/W4 shared generation-fenced authority (FAZ A #424, fencing ON only): exclusive private generation dirs; legacy worker-inode link primitive kept only as a negative control (no runtime caller, #472)'] },
  'services/photoPublicationExecutor.ts': { mutation: 1, writers: ['W2/W4 protected publication (Stage 5 F2 #472, fencing ON): readiness mkdir of the canonical/private/staging roots only; no post-commit cleanup (Gate 5 retains private derivatives and publication anchors)'] },
  'services/w4FencedFinalizationOwner.ts': { mutation: 1, writers: ['W4 confined preparation input (Stage 5 F2 #472, PHOTO_PREPARATION_CONFINEMENT=required only): exclusive wx write of the staged source into its private job directory'] },
  'services/photoCopyPublisher.ts': { mutation: 2, writers: ['W2/W4 protected publication (Stage 5 F2 #472): publisher-owned verified copy, recorded before a no-overwrite canonical link; removes only its own data-* staging names'] },
  'services/photoPreparationConfinement.ts': { mutation: 1, child: 2, writers: ['W2/W4 confined preparation (Stage 5 F2 #472, PHOTO_PREPARATION_CONFINEMENT=required only): Landlock launcher worker writing only its generation/job directories; job directory removal'] },
  'use-cases/private-photo-backup/useCases.ts': { mutation: 3, handle: 1, writers: ['NON_MEDIA (Gate 5 owner-operated cold-evidence CLI: reads the operations/publication roots and the snapshot DB; writes only a new exclusive owner-private destination that must not overlap any source root)'] },
  'services/stagedProductPhotoStorage.ts': { mutation: 4, writers: ['W2', 'W10'] },
  'services/photoStorage.ts': { mutation: 6, writers: ['W1', 'W4', 'W10', 'W4 fenced prepare (FAZ A #424): exclusive wx writes into a generation-private directory only'] },
  'services/aiIntakePhotoStorage.ts': { mutation: 11, handle: 1, writers: ['W3', 'W5', 'W3 original-source (#390, flag OFF by default; private staging writes only)'] },
  'services/managedFileDeletion.ts': { mutation: 1, writers: ['W5', 'W6'] },
  'services/productPhotoStorageWorkflow.ts': { mutation: 2, writers: ['W7', 'W8', 'W9'] },
  'services/photoCanonicalDeletion.ts': { mutation: 1, writers: ['W8 authorized canonical deletion (4C #424, fencing ON): unlinks only a committed operation\'s recorded copy names, verified under the operation row lock'] },
  'integrations/instagram/mediaPreparation.ts': { mutation: 5, writers: ['W11 (fencing OFF: canonical root, unchanged)', 'W11 protected mode (#472 parity 4B): non-canonical instagram-derivatives store, confined-render job dir; canonical root read-only'] },
  'workers/photoPreparationWorker.ts': { mutation: 1, writers: ['confined preparation worker (#472): writes only its own job directory (Landlock)'] },
  'services/w11FencedInstagramDerivativeOwner.ts': { mutation: 3, writers: ['W11 INACTIVE PROPOSAL (FAZ A #424): not imported by production code; needs owner-approved 0042 schema; private generation dir, wx write, no-overwrite link'] },
  'integrations/media/reelRenderer.ts': { mutation: 3, child: 1, writers: ['W12 (FFmpeg subprocess writes the partial MP4)'] },
  'use-cases/product-photo-backup/useCases.ts': { mutation: 5, writers: ['W13'] },
  'repositories/product-photo-backup/s3Compatible.ts': { mutation: 2, handle: 1, writers: ['W13 (FileHandle download write)'] },
  'use-cases/database-backup/useCases.ts': { mutation: 7, writers: ['W14'] },
  'repositories/database-backup/s3Compatible.ts': { mutation: 2, handle: 1, writers: ['W14 (FileHandle download write)'] },
  'services/developmentPhotoStorageCapability.ts': { mutation: 6, writers: ['DEV'] },
  'services/developmentPhotoDiskBudget.ts': { mutation: 4, writers: ['DEV'] },
  'services/developmentPhotoRecovery.ts': { mutation: 1, writers: ['DEV'] },
  'services/developmentLegacyWriterGate.ts': { mutation: 4, writers: ['DEV (gate bookkeeping, never media)'] },
  'scripts/inventoryRepositoryAudit.ts': { mutation: 3, writers: ['NON_MEDIA (audit fixtures in os.tmpdir)'] },
  'scripts/refundUseCaseAudit.ts': { mutation: 3, writers: ['NON_MEDIA (audit fixtures in os.tmpdir)'] },
  'scripts/sharedImageResourceProbe.ts': { mutation: 3, writers: ['NON_MEDIA (container resource probe evidence)'] },
};
const DEV_MODULES = ['developmentPhotoStorageCapability', 'developmentPhotoDiskBudget', 'developmentPhotoRecovery', 'developmentLegacyWriterGate'];

test('scanner detects the hardened mutation forms (self-test)', () => {
  const sample = (code) => scanText(code);
  assert.equal(sample('import fs from "node:fs"; fs.cp(a, b); fs.rmdirSync(d); fs.truncateSync(f);').mutation, 3);
  assert.equal(sample('import { cp, truncate } from "node:fs/promises"; await cp(a, b); await truncate(f);').mutation, 2);
  assert.equal(sample('const truncate = (s) => s.slice(0, 3); truncate(title);').mutation, 0, 'string helpers are not fs writes');
  assert.equal(sample('import fs from "node:fs"; fs.openSync(f, { flags: "wx" });').mutation, 1);
  assert.equal(sample('import { open } from "node:fs/promises"; const h = await open(f, "r"); await h.write(b);').handle, 1);
  assert.equal(sample('import { execFile } from "node:child_process"; execFile("ffmpeg", args);').child, 1);
  assert.equal(sample('res.write(x);').handle, 0, 'stream writes outside fs-opening files are not counted');
});

test('every filesystem / FileHandle / child-process mutation site in apps/api/src is in the writer matrix', () => {
  const actual = census();
  const problems = [];
  for (const [file, counts] of Object.entries(actual)) {
    const expected = EXPECTED[file];
    if (!expected) { problems.push(`NEW ${file} ${JSON.stringify(counts)}: classify it in the writer matrix (W#, DEV or NON_MEDIA) before adding it to EXPECTED`); continue; }
    for (const category of ['mutation', 'handle', 'child']) {
      if ((expected[category] ?? 0) !== counts[category]) problems.push(`CHANGED ${file} ${category}: expected ${expected[category] ?? 0}, found ${counts[category]} (${expected.writers.join(', ')}): review the change against the matrix, then update the count`);
    }
  }
  for (const file of Object.keys(EXPECTED)) if (!actual[file]) problems.push(`REMOVED ${file}: its mutation sites are gone; update the matrix and EXPECTED`);
  assert.deepEqual(problems, []);
});

/**
 * #406's explicit private-root producer is the single permitted reference: a type-only import
 * (erased at compile time) and one lazy require that runs only after the NODE_ENV/flag guard.
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

test('staging and fencing switches have no default-true fallback', () => {
  const hits = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      // Isolated offline resource probes (src/scripts) may set the flag only together with NODE_ENV "test" on the same line.
      if (rel(file).startsWith('scripts/') && /NODE_ENV\s*:\s*["']test["']/.test(line)) continue;
      if (/(PRODUCT_PHOTO_DISK_STAGING_ENABLED|PHOTO_OWNERSHIP_FENCING_ENABLED)\s*(\?\?|\|\|)\s*["']true|(PRODUCT_PHOTO_DISK_STAGING_ENABLED|PHOTO_OWNERSHIP_FENCING_ENABLED)["']?\s*[:=]\s*["']true/.test(line)) hits.push(`${rel(file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});
