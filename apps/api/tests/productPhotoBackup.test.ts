import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile, mkdir, symlink, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { ProductPhotoBackupObjectMetadata, ProductPhotoBackupReferenceSource, ProductPhotoBackupRepository } from "../src/repositories/product-photo-backup/types";
import { createS3CompatibleProductPhotoBackupRepository, ProductPhotoBackupConfigurationError, readS3CompatibleProductPhotoBackupConfig } from "../src/repositories/product-photo-backup/s3Compatible";
import { createProductPhotoLocalFileSource } from "../src/services/productPhotoBackupLocalSource";
import { createProductPhotoBackupUseCase, createProductPhotoRecoveryVerificationUseCase } from "../src/use-cases/product-photo-backup/useCases";
import { createProductPhotoBackupRouter } from "../src/routes/productPhotoBackup";
import { PRODUCT_PHOTO_BACKUP_REQUEST_TIMEOUT_MS, requestProductPhotoBackup } from "../src/scripts/runProductPhotoBackup";
import { createProductPhotoBackupReferenceSource } from "../src/repositories/product-photo-backup/drizzleSource";
import { createTestDb } from "./testDb";
import { productPhotos, products } from "../src/db/schema";
import { ProductStatus, ProductType } from "@noctella/shared";
import { MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES, MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES } from "../src/repositories/product-photo-backup/types";

class FakeRepository implements ProductPhotoBackupRepository {
  objects = new Map<string, { bytes: Buffer; metadata: ProductPhotoBackupObjectMetadata }>();
  uploads: string[] = [];
  downloads: string[] = [];
  uploadFailure = false;
  headOverride?: Partial<ProductPhotoBackupObjectMetadata>;
  remoteBytes?: Buffer;
  async head(objectKey: string) { const value = this.objects.get(objectKey); return value ? { ...value.metadata, ...this.headOverride } : null; }
  async upload(localPath: string, metadata: ProductPhotoBackupObjectMetadata) { if (this.uploadFailure) throw new Error("secret"); this.uploads.push(metadata.objectKey); this.objects.set(metadata.objectKey, { bytes: await readFile(localPath), metadata }); }
  async download(objectKey: string, destinationPath: string, maximumBytes: number) { this.downloads.push(destinationPath); const value = this.objects.get(objectKey); if (!value) throw new Error("missing"); const bytes = this.remoteBytes ?? value.bytes; if (bytes.length > maximumBytes) throw new Error("too large"); await writeFile(destinationPath, bytes, { flag: "wx" }); return bytes.length; }
}

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

async function fixture(main = Buffer.from("main-photo"), thumbnail = Buffer.from("thumb-photo")) {
  const root = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-backup-test-")); directories.push(root);
  await writeFile(path.join(root, "main.webp"), main); await writeFile(path.join(root, "thumb.webp"), thumbnail);
  const references: ProductPhotoBackupReferenceSource = { listPage: vi.fn().mockResolvedValue({ items: [{ photoId: "photo-1", productId: "product-1", mimeType: "image/webp", locallyOwned: true, mainStorageKey: "main.webp", thumbnailStorageKey: "thumb.webp" }] }) };
  const repository = new FakeRepository();
  const operation = createProductPhotoBackupUseCase({ references, files: createProductPhotoLocalFileSource(root), repository, prefix: "product-photo-backups", now: () => new Date("2026-08-09T04:30:00.000Z") });
  return { root, references, repository, operation, main, thumbnail };
}

const product = (id: string, status: ProductStatus) => ({ id, sku: id, slug: id, title: id, type: ProductType.UniqueItem, status, stockQuantity: 0, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
const photo = (id: string, productId: string, values: Record<string, unknown> = {}) => ({ id, productId, url: "/images/product-photos/main.webp", thumbnailUrl: "/images/product-photos/thumb.webp", filename: "main.webp", mimeType: "image/webp", sizeBytes: 999, width: 1, height: 1, storageKey: "main.webp", thumbnailStorageKey: "thumb.webp", ...values });

function seedManifest(repository: FakeRepository, manifest: Record<string, unknown>) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `product-photo-backups/manifests/20260809T043000000Z-${sha256}.json`;
  repository.objects.set(objectKey, { bytes, metadata: { objectKey, byteSize: bytes.length, sha256, contentType: "application/json", createdAt: "2026-08-09T04:30:00.000Z" } });
  return { objectKey, bytes, sha256 };
}

function validManifestEntry(overrides: Record<string, unknown> = {}) {
  const sha256 = "a".repeat(64);
  return { photoId: "photo", productId: "product", artifactRole: "main", logicalStorageKey: "main.webp", remoteObjectKey: `product-photo-backups/objects/${sha256}.webp`, actualSizeBytes: 1, sha256, mimeType: "image/webp", backupTimestamp: "2026-08-09T04:30:00.000Z", ...overrides };
}

const validManifest = (entries: unknown[]) => ({ version: 1, backupTimestamp: "2026-08-09T04:30:00.000Z", entries, counts: { backedUpLocalArtifacts: entries.length, reusedImmutableObjects: 0, newlyUploadedObjects: entries.length, unmanagedPhotoReferences: 0 } });

describe("Sprint 125 verified off-disk product photo backup", () => {
  it("paginates every DB reference and classifies local versus wholly external ownership without publication filtering", async () => {
    const db = createTestDb();
    await db.insert(products).values([{ id: "p-archived", sku: "A", slug: "a", title: "A", type: ProductType.UniqueItem, status: ProductStatus.Archived, stockQuantity: 0, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false }, { id: "p-draft", sku: "D", slug: "d", title: "D", type: ProductType.UniqueItem, status: ProductStatus.Draft, stockQuantity: 0, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false }]);
    await db.insert(productPhotos).values([{ id: "a-local", productId: "p-archived", url: "/images/product-photos/main.webp", thumbnailUrl: "/images/product-photos/thumb.webp", filename: "main.webp", mimeType: "image/webp", sizeBytes: 999, width: 1, height: 1, storageKey: "main.webp", thumbnailStorageKey: "thumb.webp" }, { id: "b-external", productId: "p-draft", url: "https://cdn.example/main.jpg", thumbnailUrl: "https://cdn.example/thumb.jpg", filename: "external.jpg", mimeType: "image/jpeg", sizeBytes: 1, width: 1, height: 1 }]);
    const source = createProductPhotoBackupReferenceSource(db); const first = await source.listPage(undefined, 1); const second = await source.listPage(first.nextCursor, 1);
    expect(first.items[0]).toMatchObject({ photoId: "a-local", productId: "p-archived", locallyOwned: true, mainStorageKey: "main.webp", thumbnailStorageKey: "thumb.webp" }); expect(second.items[0]).toMatchObject({ photoId: "b-external", productId: "p-draft", locallyOwned: false });
  });

  it("fails closed when managed keys coexist with external ownership or only one managed key exists", async () => {
    for (const values of [{ url: "https://cdn.example/main", thumbnailUrl: "https://cdn.example/thumb" }, { url: "https://cdn.example/main", thumbnailUrl: "https://cdn.example/thumb", thumbnailStorageKey: null }]) {
      const db = createTestDb(); await db.insert(products).values(product("conflict", ProductStatus.Draft)); await db.insert(productPhotos).values(photo("conflict-photo", "conflict", values));
      await expect(createProductPhotoBackupReferenceSource(db).listPage(undefined, 10)).rejects.toThrow();
    }
  });

  it("keeps wholly external rows unmanaged and fully managed rows local", async () => {
    const db = createTestDb(); await db.insert(products).values([product("local", ProductStatus.Draft), product("external", ProductStatus.Draft)]);
    await db.insert(productPhotos).values([photo("a-local", "local"), photo("b-external", "external", { url: "https://cdn.example/main", thumbnailUrl: "https://cdn.example/thumb", storageKey: null, thumbnailStorageKey: null })]);
    const rows = await createProductPhotoBackupReferenceSource(db).listPage(undefined, 10); expect(rows.items.map((row) => [row.photoId, row.locallyOwned])).toEqual([["a-local", true], ["b-external", false]]);
  });

  it("backs up a DRAFT product's locally managed main and thumbnail", async () => {
    const f = await fixture(); const db = createTestDb(); await db.insert(products).values(product("draft-local", ProductStatus.Draft)); await db.insert(productPhotos).values(photo("draft-photo", "draft-local"));
    const result = await createProductPhotoBackupUseCase({ references: createProductPhotoBackupReferenceSource(db), files: createProductPhotoLocalFileSource(f.root), repository: f.repository, prefix: "product-photo-backups", now: () => new Date("2026-08-09T04:30:00.000Z") }).execute();
    expect(result.backedUpLocalArtifacts).toBe(2); const manifest = JSON.parse(f.repository.objects.get(result.manifestKey)!.bytes.toString()); expect(manifest.entries.every((entry: any) => entry.productId === "draft-local")).toBe(true);
  });

  it("backs up DB-referenced main and thumbnail using actual bytes, stable hashes, and a verified manifest", async () => {
    const f = await fixture(); const result = await f.operation.execute();
    const mainHash = createHash("sha256").update(f.main).digest("hex"); const thumbHash = createHash("sha256").update(f.thumbnail).digest("hex");
    expect(result).toMatchObject({ backedUpLocalArtifacts: 2, newlyUploadedObjects: 2, remoteVerified: true });
    expect(f.repository.objects.has(`product-photo-backups/objects/${mainHash}.webp`)).toBe(true);
    expect(f.repository.objects.has(`product-photo-backups/objects/${thumbHash}.webp`)).toBe(true);
    expect(result.manifestKey).toMatch(/^product-photo-backups\/manifests\/20260809T043000000Z-[a-f0-9]{64}\.json$/);
    const manifest = JSON.parse(f.repository.objects.get(result.manifestKey)!.bytes.toString());
    expect(manifest.entries.map((entry: any) => [entry.artifactRole, entry.actualSizeBytes, entry.sha256])).toEqual([["main", f.main.length, mainHash], ["thumbnail", f.thumbnail.length, thumbHash]]);
    expect(manifest.entries[0]).toMatchObject({ photoId: "photo-1", productId: "product-1", logicalStorageKey: "main.webp", mimeType: "image/webp", backupTimestamp: "2026-08-09T04:30:00.000Z" });
  });

  it("does not filter draft or archived references because publication state is absent from the backup contract", async () => { const f = await fixture(); await f.operation.execute(); expect(f.references.listPage).toHaveBeenCalled(); expect(f.repository.uploads.filter((key) => key.includes("/objects/"))).toHaveLength(2); });

  it("reuses matching content-addressed objects and still publishes the manifest", async () => {
    const f = await fixture(Buffer.from("same"), Buffer.from("same")); const sha = createHash("sha256").update("same").digest("hex");
    f.repository.objects.set(`product-photo-backups/objects/${sha}.webp`, { bytes: Buffer.from("same"), metadata: { objectKey: `product-photo-backups/objects/${sha}.webp`, byteSize: 4, sha256: sha, contentType: "image/webp", createdAt: "earlier" } });
    const result = await f.operation.execute(); expect(result).toMatchObject({ reusedImmutableObjects: 2, newlyUploadedObjects: 0 }); expect(f.repository.uploads.filter((key) => key.includes("/objects/"))).toHaveLength(0);
  });

  it("fails closed for conflicting immutable-object metadata without publishing a manifest", async () => {
    const f = await fixture(); const hash = createHash("sha256").update(f.main).digest("hex");
    f.repository.objects.set(`product-photo-backups/objects/${hash}.webp`, { bytes: f.main, metadata: { objectKey: `product-photo-backups/objects/${hash}.webp`, byteSize: 999, sha256: hash, contentType: "image/webp", createdAt: "earlier" } });
    await expect(f.operation.execute()).rejects.toThrow(); expect(f.repository.uploads.some((key) => key.includes("/manifests/"))).toBe(false);
  });

  it.each(["main.webp", "thumb.webp"])("fails when referenced artifact %s is missing and publishes no manifest", async (name) => { const f = await fixture(); await rm(path.join(f.root, name)); await expect(f.operation.execute()).rejects.toThrow(); expect(f.repository.uploads.some((key) => key.includes("/manifests/"))).toBe(false); });

  it("rejects a local artifact larger than exactly 16 MiB before upload or manifest publication", async () => {
    const f = await fixture(); await truncate(path.join(f.root, "main.webp"), MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES + 1); await expect(f.operation.execute()).rejects.toThrow("Product photo backup or verification failed"); expect(f.repository.uploads).toHaveLength(0); expect(MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES).toBe(16_777_216);
  });

  it.each(["../escape.webp", "C:\\escape.webp", "", "nested/file.webp"])("rejects unsafe local key %s", async (key) => { const f = await fixture(); await expect(createProductPhotoLocalFileSource(f.root).inspect(key)).rejects.toThrow("local artifact validation failed"); });

  it("rejects directories and symlinks", async () => {
    const f = await fixture(); await mkdir(path.join(f.root, "directory.webp")); await expect(createProductPhotoLocalFileSource(f.root).inspect("directory.webp")).rejects.toThrow();
    await symlink(path.join(f.root, "directory.webp"), path.join(f.root, "link.webp"), "junction"); await expect(createProductPhotoLocalFileSource(f.root).inspect("link.webp")).rejects.toThrow();
  });

  it("fails when stable file metadata changes while bytes are being read", async () => {
    const f = await fixture(); const original = await lstat(path.join(f.root, "main.webp")); let calls = 0;
    const changingLstat = vi.fn(async () => { calls += 1; return calls === 1 ? original : Object.assign(Object.create(Object.getPrototypeOf(original)), original, { mtimeMs: original.mtimeMs + 1 }); });
    await expect(createProductPhotoLocalFileSource(f.root, { lstat: changingLstat as typeof lstat }).inspect("main.webp")).rejects.toThrow("local artifact validation failed");
  });

  it("counts external/unmanaged references without fetching or failing them", async () => {
    const repository = new FakeRepository(); const files = { inspect: vi.fn() };
    const references = { listPage: vi.fn().mockResolvedValue({ items: [{ photoId: "external", productId: "p", mimeType: "image/jpeg", locallyOwned: false }] }) };
    const result = await createProductPhotoBackupUseCase({ references, files, repository, prefix: "product-photo-backups", now: () => new Date("2026-08-09T04:30:00.000Z") }).execute();
    expect(result.unmanagedPhotoReferences).toBe(1); expect(files.inspect).not.toHaveBeenCalled();
  });

  it("upload or remote verification failure prevents manifest publication", async () => { const f = await fixture(); f.repository.uploadFailure = true; await expect(f.operation.execute()).rejects.toThrow(); expect(f.repository.uploads.some((key) => key.includes("/manifests/"))).toBe(false); });

  it("detects downloaded SHA mismatch for a newly uploaded object", async () => { const f = await fixture(); f.repository.remoteBytes = Buffer.alloc(f.main.length, 1); await expect(f.operation.execute()).rejects.toThrow(); expect(f.repository.uploads.some((key) => key.includes("/manifests/"))).toBe(false); });

  it("generates the same sorted manifest from differently ordered reference input", async () => {
    const f = await fixture(); const refs = [{ photoId: "z", productId: "p", mimeType: "image/webp", locallyOwned: true, mainStorageKey: "main.webp", thumbnailStorageKey: "thumb.webp" }, { photoId: "a", productId: "p", mimeType: "image/webp", locallyOwned: true, mainStorageKey: "main.webp", thumbnailStorageKey: "thumb.webp" }];
    const run = async (items: typeof refs) => { const repository = new FakeRepository(); const result = await createProductPhotoBackupUseCase({ references: { listPage: vi.fn().mockResolvedValue({ items }) }, files: createProductPhotoLocalFileSource(f.root), repository, prefix: "product-photo-backups", now: () => new Date("2026-08-09T04:30:00.000Z") }).execute(); return repository.objects.get(result.manifestKey)!.bytes; };
    const forward = await run(refs); const reverse = await run([...refs].reverse()); expect(reverse).toEqual(forward); expect(JSON.parse(forward.toString()).entries.map((entry: any) => entry.photoId)).toEqual(["a", "a", "z", "z"]);
  });

  it("rejects a generated manifest larger than exactly 16 MiB before manifest upload", async () => {
    const f = await fixture(); const hugeId = "x".repeat(MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES); const repository = new FakeRepository(); const sha256 = createHash("sha256").update(f.main).digest("hex"); repository.objects.set(`product-photo-backups/objects/${sha256}.webp`, { bytes: f.main, metadata: { objectKey: `product-photo-backups/objects/${sha256}.webp`, byteSize: f.main.length, sha256, contentType: "image/webp", createdAt: "earlier" } });
    await expect(createProductPhotoBackupUseCase({ references: { listPage: vi.fn().mockResolvedValue({ items: [{ photoId: hugeId, productId: "p", mimeType: "image/webp", locallyOwned: true, mainStorageKey: "main.webp", thumbnailStorageKey: "main.webp" }] }) }, files: createProductPhotoLocalFileSource(f.root), repository, prefix: "product-photo-backups" }).execute()).rejects.toThrow(); expect(repository.uploads.some((key) => key.includes("/manifests/"))).toBe(false); expect(MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES).toBe(16_777_216);
  });

  it("recovery verification validates manifest and every object only in unique temporary paths", async () => {
    const f = await fixture(); const backup = await f.operation.execute(); const before = await readFile(path.join(f.root, "main.webp"));
    const result = await createProductPhotoRecoveryVerificationUseCase(f.repository, "product-photo-backups").execute(backup.manifestKey);
    expect(result).toMatchObject({ integrity: "ok", verifiedArtifacts: 2 }); expect(f.repository.downloads.every((value) => !value.startsWith(f.root))).toBe(true); expect(await readFile(path.join(f.root, "main.webp"))).toEqual(before);
  });

  it("rejects remote manifest Head size above 16 MiB before GetObject", async () => {
    const repository = new FakeRepository(); const seeded = seedManifest(repository, validManifest([])); repository.objects.get(seeded.objectKey)!.metadata.byteSize = MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES + 1;
    await expect(createProductPhotoRecoveryVerificationUseCase(repository, "product-photo-backups").execute(seeded.objectKey)).rejects.toThrow(); expect(repository.downloads).toHaveLength(0);
  });

  it("rejects a manifest-declared artifact above 16 MiB before artifact Head or GetObject", async () => {
    const repository = new FakeRepository(); const seeded = seedManifest(repository, validManifest([validManifestEntry({ actualSizeBytes: MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES + 1 })]));
    await expect(createProductPhotoRecoveryVerificationUseCase(repository, "product-photo-backups").execute(seeded.objectKey)).rejects.toThrow(); expect(repository.downloads).toHaveLength(1);
  });

  it("rejects oversized remote artifact Head metadata before artifact GetObject", async () => {
    const repository = new FakeRepository(); const entry = validManifestEntry(); const seeded = seedManifest(repository, validManifest([entry])); repository.objects.set(entry.remoteObjectKey, { bytes: Buffer.from("x"), metadata: { objectKey: entry.remoteObjectKey, byteSize: MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES + 1, sha256: entry.sha256, contentType: "image/webp", createdAt: "now" } });
    await expect(createProductPhotoRecoveryVerificationUseCase(repository, "product-photo-backups").execute(seeded.objectKey)).rejects.toThrow(); expect(repository.downloads).toHaveLength(1);
  });

  it("rejects manifest Head size mismatch during manifest-specific verification", async () => {
    const repository = new FakeRepository(); const seeded = seedManifest(repository, validManifest([])); repository.objects.get(seeded.objectKey)!.metadata.byteSize += 1;
    await expect(createProductPhotoRecoveryVerificationUseCase(repository, "product-photo-backups").execute(seeded.objectKey)).rejects.toThrow(); expect(repository.downloads).toHaveLength(1);
  });

  it("rejects a corrupt manifest download before any artifact verification", async () => {
    const repository = new FakeRepository(); const bytes = Buffer.from("{not-json"); const sha256 = createHash("sha256").update(bytes).digest("hex"); const objectKey = `product-photo-backups/manifests/20260809T043000000Z-${sha256}.json`; repository.objects.set(objectKey, { bytes, metadata: { objectKey, byteSize: bytes.length, sha256, contentType: "application/json", createdAt: "now" } });
    await expect(createProductPhotoRecoveryVerificationUseCase(repository, "product-photo-backups").execute(objectKey)).rejects.toThrow(); expect(repository.downloads).toHaveLength(1);
  });

  it("rejects an undersized GetObject stream and removes the temporary partial output", async () => {
    const f = await fixture(); f.repository.remoteBytes = Buffer.from("x"); await expect(f.operation.execute()).rejects.toThrow(); expect(f.repository.downloads).toHaveLength(1); await expect(readFile(f.repository.downloads[0])).rejects.toThrow();
  });

  it.each(["", "../manifest.json", "C:\\manifest.json", "product-photo-backups\\manifests\\x.json", "other/manifests/20260809T043000000Z-" + "a".repeat(64) + ".json"])("rejects unsafe recovery manifest key %s", async (key) => { await expect(createProductPhotoRecoveryVerificationUseCase(new FakeRepository(), "product-photo-backups").execute(key)).rejects.toThrow(); });

  it("uses separate fail-closed photo backup configuration", () => {
    expect(() => readS3CompatibleProductPhotoBackupConfig({ PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID: "visible", PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY: "secret" } as NodeJS.ProcessEnv)).toThrow(ProductPhotoBackupConfigurationError);
    const config = readS3CompatibleProductPhotoBackupConfig({ PRODUCT_PHOTO_BACKUP_S3_REGION: "r", PRODUCT_PHOTO_BACKUP_S3_BUCKET: "b", PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID: "i", PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY: "s" } as NodeJS.ProcessEnv); expect(config.prefix).toBe("product-photo-backups");
  });

  it.each(["/", "../x", "backup/../x", "backup//x", "backup\\x", "backup..x"])("rejects unsafe prefix %s", (prefix) => { expect(() => readS3CompatibleProductPhotoBackupConfig({ PRODUCT_PHOTO_BACKUP_S3_REGION: "r", PRODUCT_PHOTO_BACKUP_S3_BUCKET: "b", PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID: "i", PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY: "s", PRODUCT_PHOTO_BACKUP_S3_PREFIX: prefix } as NodeJS.ProcessEnv)).toThrow(ProductPhotoBackupConfigurationError); });

  it("route requires scheduler auth and ignores caller configuration", async () => {
    vi.stubEnv("SCHEDULER_AUTH_TOKEN", "expected"); const run = vi.fn().mockResolvedValue({ remoteVerified: true }); const app = express(); app.use(express.json()); app.use("/backup", createProductPhotoBackupRouter(run));
    await request(app).post("/backup").expect(401); await request(app).post("/backup").set("Authorization", "Bearer expected").send({ root: "C:/forbidden", bucket: "forbidden" }).expect(200); expect(run).toHaveBeenCalledWith();
  });

  it("HTTP-only client sends bearer auth and uses the established timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 }); const result = await requestProductPhotoBackup({ API_HOSTPORT: "api.internal:4000", SCHEDULER_AUTH_TOKEN: "token" } as NodeJS.ProcessEnv, fetchMock as never);
    expect(result).toEqual({ ok: true, status: 200 }); expect(fetchMock).toHaveBeenCalledWith("http://api.internal:4000/api/background-jobs/product-photo-backup", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer token" } })); expect(PRODUCT_PHOTO_BACKUP_REQUEST_TIMEOUT_MS).toBe(900_000);
  });

  it("aborts an unresolved HTTP-only request after exactly 900000 ms", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener("abort", () => reject(new DOMException("hidden-token", "AbortError")), { once: true }); }));
    const operation = requestProductPhotoBackup({ API_HOSTPORT: "api.internal:4000", SCHEDULER_AUTH_TOKEN: "token" } as NodeJS.ProcessEnv, fetchMock as typeof fetch);
    await vi.advanceTimersByTimeAsync(PRODUCT_PHOTO_BACKUP_REQUEST_TIMEOUT_MS - 1); expect(signal?.aborted).toBe(false); await vi.advanceTimersByTimeAsync(1); await expect(operation).resolves.toEqual({ ok: false, error: "Product photo backup request failed" }); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("concrete adapter streams Put/Head/Get metadata and exposes no delete behavior", async () => {
    const f = await fixture(); const destination = path.join(f.root, "download.webp"); const bytes = Buffer.from("proof"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const send = vi.fn(async (command: unknown) => { if (command instanceof PutObjectCommand) return {}; if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ContentType: "image/webp", Metadata: { sha256, "size-bytes": String(bytes.length), "created-at": "now" } }; if (command instanceof GetObjectCommand) return { Body: (async function* () { yield bytes; })() }; throw new Error(); });
    const repository = createS3CompatibleProductPhotoBackupRepository({ region: "r", bucket: "b", accessKeyId: "i", secretAccessKey: "s", forcePathStyle: true, prefix: "product-photo-backups" }, { send } as never); const metadata = { objectKey: `product-photo-backups/objects/${sha256}.webp`, byteSize: bytes.length, sha256, contentType: "image/webp", createdAt: "now" }; await writeFile(path.join(f.root, "proof.webp"), bytes); await repository.upload(path.join(f.root, "proof.webp"), metadata); expect(await repository.head(metadata.objectKey)).toEqual(metadata); await repository.download(metadata.objectKey, destination, bytes.length); expect(await readFile(destination)).toEqual(bytes); expect("delete" in repository).toBe(false);
  });

  it("bounded adapter download removes partial output on overflow or stream failure", async () => {
    const f = await fixture(); for (const body of [(async function* () { yield Buffer.from("too-large"); })(), (async function* () { yield Buffer.from("x"); throw new Error("stream"); })()]) { const destination = path.join(f.root, `partial-${Math.random()}`); const repository = createS3CompatibleProductPhotoBackupRepository({ region: "r", bucket: "b", accessKeyId: "i", secretAccessKey: "s", forcePathStyle: true, prefix: "product-photo-backups" }, { send: vi.fn().mockResolvedValue({ Body: body }) } as never); await expect(repository.download("key", destination, 1)).rejects.toThrow(); await expect(readFile(destination)).rejects.toThrow(); }
  });
});

describe("Sprint 125 Render schedule", () => {
  it("adds only the 04:30 HTTP photo trigger and preserves existing schedules and isolation", async () => {
    const yaml = await readFile(path.resolve(__dirname, "../../../render.yaml"), "utf8"); expect(yaml).toContain('schedule: "30 4 * * *"'); expect(yaml).toContain('schedule: "0 3 * * *"'); expect(yaml).toContain('schedule: "0 * * * *"');
    const section = yaml.slice(yaml.indexOf("name: noctella-staging-product-photo-backup")); expect(section).not.toContain("DATABASE_URL"); expect(section).not.toContain("PRODUCT_PHOTO_DIR"); expect(section).not.toContain("PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY"); expect(section).not.toContain("disk:");
  });
});
