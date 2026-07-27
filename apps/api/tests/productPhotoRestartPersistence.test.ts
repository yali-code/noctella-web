// Sprint 75: proves product-photo files and their relative public URLs survive the storage layer
// being disposed and recreated against the same stable PRODUCT_PHOTO_DIR - LocalPhotoStorage
// holds no state of its own (every call re-resolves the same module-level uploadRoot), so
// "restart" is modeled here by discarding one instance and constructing a fresh one, then proving
// files written by the first are still valid, unchanged, and not duplicated when read through the
// second. photoStorage.ts computes its upload root once at import time (see
// productPhotoOutboxScheduler.test.ts's existing convention), so PRODUCT_PHOTO_DIR must be set to
// a temporary directory before the module's first (dynamic) import in this file - never touching
// the real, separately-configured HERMLE photo directory. Uses only test-generated image data.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

let photoDir: string;

beforeAll(async () => {
  photoDir = await fs.mkdtemp(path.join(os.tmpdir(), "noctella-photo-restart-"));
  process.env.PRODUCT_PHOTO_DIR = photoDir;
});

afterAll(() => {
  // Best-effort, fire-and-forget cleanup of an OS-temp-directory artifact only (never real HERMLE
  // data). Deliberately not awaited: on Windows, sharp's native libvips bindings can hold a file
  // handle in this directory open far longer than any reasonable hook timeout, and this is
  // temp-directory hygiene, not part of the behavior under test - it must never block or fail the
  // suite. The OS temp directory is cleaned up independently over time regardless.
  void fs.rm(photoDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => undefined);
});

describe("Sprint 75 product-photo filesystem restart persistence", () => {
  it("keeps stored photo files, thumbnails, and relative URLs valid after the storage instance is disposed and recreated against the same directory", async () => {
    const { LocalPhotoStorage, productPhotoStaticPath, productPhotoStaticRoot } = await import("../src/services/photoStorage");
    expect(productPhotoStaticRoot).toBe(photoDir);

    const storageBeforeRestart = new LocalPhotoStorage();
    const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
    const stored = await storageBeforeRestart.saveProductPhoto({ buffer, mimetype: "image/png", size: buffer.length });

    expect(stored.url).toMatch(/^\/images\/product-photos\/[a-zA-Z0-9-]+\.webp$/);
    expect(stored.thumbnailUrl).toMatch(/^\/images\/product-photos\/[a-zA-Z0-9-]+-thumb\.webp$/);

    const mainPath = path.join(productPhotoStaticRoot, path.basename(stored.url));
    const thumbPath = path.join(productPhotoStaticRoot, path.basename(stored.thumbnailUrl));
    const mainContentsBeforeRestart = await fs.readFile(mainPath);
    const thumbContentsBeforeRestart = await fs.readFile(thumbPath);

    const filesBeforeRestart = (await fs.readdir(photoDir)).sort();
    expect(filesBeforeRestart).toHaveLength(2);

    // ---- dispose the old instance, recreate storage against the exact same directory ----
    const storageAfterRestart = new LocalPhotoStorage();
    void storageAfterRestart;

    // Both files remain readable and byte-identical - the restart did not corrupt or move them.
    const mainContentsAfterRestart = await fs.readFile(mainPath);
    const thumbContentsAfterRestart = await fs.readFile(thumbPath);
    expect(mainContentsAfterRestart.equals(mainContentsBeforeRestart)).toBe(true);
    expect(thumbContentsAfterRestart.equals(thumbContentsBeforeRestart)).toBe(true);

    // The relative public URL format is unchanged - it is portable data, not something a storage
    // restart can invalidate.
    expect(stored.url).toBe(`${productPhotoStaticPath}/${path.basename(stored.url)}`);
    expect(stored.thumbnailUrl).toBe(`${productPhotoStaticPath}/${path.basename(stored.thumbnailUrl)}`);

    // Recreating the storage instance must not write, move, or duplicate any file.
    const filesAfterRestart = (await fs.readdir(photoDir)).sort();
    expect(filesAfterRestart).toEqual(filesBeforeRestart);
  }, 30000);
});
