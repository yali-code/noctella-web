import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProductPhotoBackupObjectMetadata, ProductPhotoBackupRepository } from "../src/repositories/product-photo-backup/types";
import { createProductPhotoRecoveryVerificationUseCase, ProductPhotoBackupError } from "../src/use-cases/product-photo-backup/useCases";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const prefix = "product-photo-backups";
const timestamp = "2026-08-09T04:30:00.000Z";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots = new Set<string>();
let realFs: typeof import("node:fs/promises");
beforeAll(async () => { realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); });

afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(realFs.rm);
  for (const root of roots) await realFs.rm(root, { recursive: true, force: true });
  roots.clear();
});

function fixture(count: number) {
  const objects = new Map<string, { bytes: Buffer; metadata: ProductPhotoBackupObjectMetadata }>();
  const entries = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from("synthetic-photo-" + index);
    const sha256 = hash(bytes);
    const remoteObjectKey = prefix + "/objects/" + sha256 + ".webp";
    objects.set(remoteObjectKey, { bytes, metadata: { objectKey: remoteObjectKey, byteSize: bytes.length, sha256, contentType: "image/webp", createdAt: timestamp } });
    return { photoId: "photo-" + index, productId: "product", artifactRole: index % 2 ? "thumbnail" : "main", logicalStorageKey: index + ".webp", remoteObjectKey, actualSizeBytes: bytes.length, sha256, mimeType: "image/webp", backupTimestamp: timestamp };
  });
  const bytes = Buffer.from(JSON.stringify({ version: 1, backupTimestamp: timestamp, entries, counts: { backedUpLocalArtifacts: count, reusedImmutableObjects: 0, newlyUploadedObjects: count, unmanagedPhotoReferences: 0 } }));
  const manifestKey = prefix + "/manifests/20260809T043000000Z-" + hash(bytes) + ".json";
  objects.set(manifestKey, { bytes, metadata: { objectKey: manifestKey, byteSize: bytes.length, sha256: hash(bytes), contentType: "application/json", createdAt: timestamp } });
  let peakBytes = 0;
  let peakArtifacts = 0;
  const destinations: string[] = [];
  const repository: ProductPhotoBackupRepository = {
    head: vi.fn(async (key) => objects.get(key)?.metadata ?? null),
    upload: vi.fn(async () => { throw new Error("Recovery must never upload"); }),
    download: vi.fn(async (key, destination, maximumBytes) => {
      const root = path.dirname(destination);
      roots.add(root);
      // This invariant fails against the old verifier even if final cleanup succeeds.
      expect((await readdir(root)).filter((name) => name.startsWith("artifact-"))).toEqual([]);
      destinations.push(destination);
      const object = objects.get(key);
      if (!object || object.bytes.length > maximumBytes) throw new Error("download failed");
      await writeFile(destination, object.bytes, { flag: "wx" });
      const names = await readdir(root);
      peakArtifacts = Math.max(peakArtifacts, names.filter((name) => name.startsWith("artifact-")).length);
      const sizes = await Promise.all(names.map(async (name) => (await stat(path.join(root, name))).size));
      peakBytes = Math.max(peakBytes, sizes.reduce((sum, size) => sum + size, 0));
      return object.bytes.length;
    }),
  };
  const verify = () => createProductPhotoRecoveryVerificationUseCase(repository, prefix).execute(manifestKey);
  return { objects, entries, repository, manifestKey, manifestBytes: bytes.length, destinations, verify, peak: () => ({ bytes: peakBytes, artifacts: peakArtifacts }) };
}

async function expectRemoved(destinations: string[]) {
  for (const destination of destinations) {
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(destination))).rejects.toMatchObject({ code: "ENOENT" });
  }
}

describe("P2-4a bounded-disk recovery verification", () => {
  it.each([0, 4, 1000])("verifies %i artifacts with at most manifest plus one artifact on disk", async (count) => {
    const f = fixture(count);
    const snapshot = [...f.objects].map(([key, object]) => [key, object.bytes.toString("hex"), { ...object.metadata }]);
    await expect(f.verify()).resolves.toEqual({ manifestKey: f.manifestKey, verifiedArtifacts: count, integrity: "ok" });
    expect(f.peak()).toEqual({ bytes: f.manifestBytes + Math.max(0, ...f.entries.map((entry) => entry.actualSizeBytes)), artifacts: count ? 1 : 0 });
    expect(f.repository.download).toHaveBeenCalledTimes(count + 1);
    expect(f.repository.upload).not.toHaveBeenCalled();
    expect([...f.objects].map(([key, object]) => [key, object.bytes.toString("hex"), { ...object.metadata }])).toEqual(snapshot);
    await expectRemoved(f.destinations);
  }, 30000);

  it("can verify the same immutable manifest repeatedly in independent empty directories", async () => {
    const f = fixture(3);
    const first = await f.verify();
    await expect(f.verify()).resolves.toEqual(first);
    expect(new Set(f.destinations.map((destination) => path.dirname(destination))).size).toBe(2);
    expect(f.repository.upload).not.toHaveBeenCalled();
    await expectRemoved(f.destinations);
  });

  it.each(["checksum", "missing", "partial", "download", "disk-full", "reported-size", "actual-size"] as const)("fails closed on %s and removes temporary downloads", async (failure) => {
    const f = fixture(3);
    const entry = f.entries[1];
    const object = f.objects.get(entry.remoteObjectKey)!;
    if (failure === "checksum") object.bytes = Buffer.alloc(object.bytes.length, 120);
    if (failure === "missing") f.objects.delete(entry.remoteObjectKey);
    if (failure === "partial") object.bytes = object.bytes.subarray(0, 2);
    const download = f.repository.download;
    if (["download", "disk-full", "reported-size", "actual-size"].includes(failure)) {
      f.repository.download = vi.fn(async (key, destination, maximumBytes) => {
        if (key !== entry.remoteObjectKey) return download(key, destination, maximumBytes);
        f.destinations.push(destination);
        await writeFile(destination, object.bytes.subarray(0, failure === "actual-size" ? 2 : object.bytes.length), { flag: "wx" });
        if (failure === "download" || failure === "disk-full") throw Object.assign(new Error("private detail"), { code: failure === "disk-full" ? "ENOSPC" : "EIO" });
        return failure === "reported-size" ? 1 : object.bytes.length;
      });
    }
    await expect(f.verify()).rejects.toThrow(ProductPhotoBackupError);
    expect(f.repository.head).not.toHaveBeenCalledWith(f.entries[2].remoteObjectKey);
    expect(f.repository.upload).not.toHaveBeenCalled();
    await expectRemoved(f.destinations);
  });

  it("stops before the next artifact if per-artifact cleanup fails, then retries whole-directory cleanup", async () => {
    const f = fixture(3);
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (path.basename(String(target)) === "artifact-0.webp") throw new Error("cleanup denied");
      return realFs.rm(target, options);
    });
    await expect(f.verify()).rejects.toThrow(ProductPhotoBackupError);
    expect(f.repository.download).toHaveBeenCalledTimes(2);
    await expectRemoved(f.destinations);
    vi.mocked(rm).mockImplementation(realFs.rm);
    await expect(f.verify()).resolves.toMatchObject({ verifiedArtifacts: 3, integrity: "ok" });
  });

  it("does not report success when final directory cleanup fails, including an empty manifest", async () => {
    const f = fixture(0);
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (options?.recursive) throw new Error("cleanup denied");
      return realFs.rm(target, options);
    });
    await expect(f.verify()).rejects.toThrow(ProductPhotoBackupError);
    expect(await readFile(f.destinations[0])).toBeDefined();
  });
});
