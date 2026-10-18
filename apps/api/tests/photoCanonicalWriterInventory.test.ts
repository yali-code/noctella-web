/**
 * Stage 5 F2 (#472) all-writer governance of the canonical product-photo namespace (PRODUCT_PHOTO_DIR, its private
 * operation root and its publication staging root). W2/W4 coverage alone does not prove all-writer protection, so this
 * inventory fails when a runtime module that can reach those roots gains a filesystem mutation without being
 * classified here, when runtime code imports the legacy worker-inode primitive or the dormant W11 owner, or when a
 * refusal gate disappears. Behavioural refusals are asserted in photoOwnershipFencingSwitch.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.join(__dirname, "../src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const rel = (file: string) => path.relative(src, file).split(path.sep).join("/");
const read = (r: string) => fs.readFileSync(path.join(src, r), "utf8");
const ROOT_REFERENCE = /productPhotoStaticRoot|PRODUCT_PHOTO_DIR|photoOperationPrivateRoot|photoPublicationStagingRoot|permanentRoot|tempRoot/;
const MUTATION = /\b(link|linkSync|writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|copyFile|copyFileSync|mkdir|mkdirSync|symlink|truncate|createWriteStream|appendFile)\(|\.toFile\(|["']wx\+?["']/;

/** Every runtime module that can reach the protected roots AND mutates the filesystem, with its governance. */
const GOVERNED: Record<string, string> = {
  "services/photoPublicationExecutor.ts": "protected publisher: readiness mkdir, copy-owned publication, post-commit cleanup of its own namespace",
  "services/w4FencedFinalizationOwner.ts": "W4 owner: confined-preparation input copy into its private job directory only (no canonical write)",
  "services/photoOperationAuthority.ts": "generation-private directories; legacy publishSealedArtifacts primitive (no runtime caller, asserted below)",
  "services/photoStorage.ts": "W1 legacy upload/delete (refused with fencing ON) and generation-private W4 preparation",
  "services/stagedProductPhotoStorage.ts": "W10 staged upload (refused with fencing ON) and generation-private W2 preparation",
  "services/w11FencedInstagramDerivativeOwner.ts": "dormant W11 owner (0042 unregistered; no runtime importer, asserted below)",
  "integrations/instagram/mediaPreparation.ts": "live Instagram prepare-image derivative writer (refused with fencing ON before any write)",
  "services/productPhotoStorageWorkflow.ts": "W7 promotion / W8 delete / W9 temp cleanup (refused with fencing ON)",
  "services/aiIntakePhotoStorage.ts": "AI intake root only (AI_INTAKE_PHOTO_DIR), never the canonical root",
  "services/mediaPlanner.ts": "MEDIA_ASSET_DIR only; reads canonical photos",
  "routes/productPhotoUpload.ts": "request upload staging (.product-photo-upload-staging) only",
  "services/aiIntakePhotoFinalization.ts": "post-commit cleanup of committed generations' private files and staging namespaces",
  "services/photoPublicationRecoveryPolicy.ts": "disposable recovery-policy roots only",
  "scripts/sharedImageResourceProbe.ts": "disposable Linux probe (refuses non-disposable roots)",
  "scripts/photoReleasePreflight.ts": "read-only preflight (creates nothing)",
};

describe("canonical photo writer inventory (#472)", () => {
  const runtime = files(src).map(rel);

  it("classifies every runtime module that can reach the protected roots and mutates the filesystem", () => {
    const writers = runtime.filter((r) => { const s = read(r); return ROOT_REFERENCE.test(s) && MUTATION.test(s); }).sort();
    expect(writers).toEqual(Object.keys(GOVERNED).filter((r) => { const s = read(r); return ROOT_REFERENCE.test(s) && MUTATION.test(s); }).sort());
    for (const writer of writers) expect(GOVERNED[writer], `unclassified canonical writer: ${writer}`).toBeTruthy();
  });

  it("no runtime module calls the legacy worker-inode publication primitive or imports the dormant W11 owner", () => {
    for (const r of runtime) {
      const s = read(r);
      if (r !== "services/photoOperationAuthority.ts") expect(s, r).not.toMatch(/\bpublishSealedArtifacts\b/);
      if (r !== "services/w11FencedInstagramDerivativeOwner.ts") expect(s, r).not.toMatch(/w11FencedInstagramDerivativeOwner/);
    }
  });

  it("the fenced W2/W4 owners publish only through the protected copy publisher and the intent-authorized commit", () => {
    for (const owner of ["services/w2FencedProductPhotoOwner.ts", "services/w4FencedFinalizationOwner.ts"]) {
      const s = read(owner);
      expect(s).toMatch(/assertPhotoPublicationReady\(/);
      expect(s).toMatch(/acquirePublicationIntent\(/);
      expect(s).toMatch(/publishAuthorizedArtifacts\(/);
      expect(s).toMatch(/guardedReclaimSteps\(/);
      expect(s).not.toMatch(/claimExistingOperation\(/);
      expect(s).not.toMatch(/\blink\(|linkSync\(/);
      expect(s).toMatch(/intent: \{ epoch: authority\.epoch, token: authority\.token, executorIdentity: authority\.executorIdentity \}/);
    }
  });

  it("every other canonical writer keeps its fencing refusal before mutating", () => {
    const before = (r: string, guard: RegExp, mutation: RegExp) => {
      const s = read(r), g = s.search(guard);
      expect(g, `${r}: refusal missing`).toBeGreaterThanOrEqual(0);
      // The guarded mutation must follow its refusal (searched after the guard).
      expect(s.slice(g).search(mutation), `${r}: guarded mutation missing after ${guard}`).toBeGreaterThan(0);
    };
    before("integrations/instagram/mediaPreparation.ts", /if \(photoOwnershipFencingEnabled\(\)\) throw/, /await link\(temporary, destination\)/);
    before("services/productPhotoStorageWorkflow.ts", /refuseUnadoptedPhotoWriter\("W7_DISTINCT_ROOT_PROMOTION"\)/, /await copyIdempotent\(/);
    before("services/productPhotoStorageWorkflow.ts", /refuseUnadoptedPhotoWriter\("W8_CANONICAL_DELETE"\)/, /await unlinkIdempotent\(safeJoin\(this\.roots\.permanentRoot/);
    before("services/productPhotoStorageWorkflow.ts", /refuseUnadoptedPhotoWriter\("W9_TEMP_CLEANUP"\)/, /await unlinkIdempotent\(safeJoin\(this\.roots\.tempRoot/);
    before("services/aiIntakeCleanup.ts", /refuseUnadoptedPhotoWriter\("W6_AI_CLEANUP_CANONICAL_DELETE"\)/, /deleteManagedFile\(productPhotoStaticRoot/);
    for (const fn of ["uploadProductPhoto", "uploadStagedProductPhoto"]) {
      const s = read("services/products.ts"), start = s.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = s.slice(start, s.indexOf("\n}\n", start));
      expect(body.indexOf("refuseUnfencedProductUpload();")).toBeGreaterThan(0);
      expect(body.indexOf("refuseUnfencedProductUpload();")).toBeLessThan(body.indexOf("storage.save"));
    }
    expect(read("routes/productPhotoUpload.ts")).toMatch(/if \(fencingOn && !options\.fencedUpload\)\s*throw new PhotoUploadError\(503/);
    expect(read("use-cases/ai-intake-photo-finalize/useCases.ts")).toMatch(/refuseUnadoptedPhotoWriter\("W4_AI_FINALIZE"\)/);
  });
});
