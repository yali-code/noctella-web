/**
 * #472 parity 4B review finding F1: an unavailable confined worker (start failure, Landlock not enforced, timeout ->
 * 503 PHOTO_PREPARATION_UNAVAILABLE) is a retryable `processing` refusal, never a permanent `invalid_media`, and leaves
 * the canonical root and the derivative store without new files.
 */
import { afterAll, expect, it, vi } from "vitest";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-ig-confined-fail-"));
  Object.assign(process.env, { PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos"), INSTAGRAM_MEDIA_ALLOWED_HOSTS: "media.example.test" });
  return { root };
});

vi.mock("../src/services/photoPreparationConfinement", async (original) => {
  const { PhotoUploadError } = await import("../src/services/photoUploadAdmission");
  return {
    ...(await original<typeof import("../src/services/photoPreparationConfinement")>()),
    photoPreparationConfinementConfig: () => ({ mode: "confined", launcher: "/opt/launcher" }),
    assertPreparationConfinementReady: () => undefined,
    renderDerivativeInConfinedWorker: async () => { throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Photo preparation worker was not confined"); },
  };
});

import { instagramDerivativeRoot, prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";

afterAll(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

it("a 503 from the confined worker is a retryable processing refusal with no published derivative", async () => {
  const canonical = path.join(root, "photos");
  fs.mkdirSync(canonical, { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#305080" } }).webp().toFile(path.join(canonical, "p-1.webp"));
  const before = fs.readdirSync(canonical).sort();
  await expect(prepareInstagramImageAsset({ url: "/images/product-photos/p-1.webp" }, "https://media.example.test", process.env, canonical))
    .rejects.toMatchObject({ kind: "processing", retryable: true });
  expect(fs.readdirSync(canonical).sort()).toEqual(before);
  const store = instagramDerivativeRoot(canonical);
  expect(fs.existsSync(store) ? fs.readdirSync(store) : []).toEqual([]); // no derivative, temp file or job directory left
});
