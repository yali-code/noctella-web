import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { createSocialContentPreparationService } from "../src/services/socialContentPreparation";
import { prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";

let db: ReturnType<typeof createTestDb>;
let root: string;
let source: Buffer;
const origin = "https://api.staging.noctella.com";
const render = (photo: { url: string }, publicOrigin: string) => prepareInstagramImageAsset(photo, publicOrigin,
  { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.staging.noctella.com" }, root);
const service = (renderer: typeof prepareInstagramImageAsset = render) => createSocialContentPreparationService(db, "test-memory", renderer);
const rows = () => db.select().from(schema.socialPreparedImages);
beforeEach(async () => {
  db = createTestDb();
  root = await mkdtemp(path.join(tmpdir(), "social-preparation-"));
  source = await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).webp().toBuffer();
  await writeFile(path.join(root, "source.webp"), source);
  await db.insert(schema.products).values({ id: "p", sku: "p", title: "p", slug: "p", type: "unique_item", status: "draft" });
  await db.insert(schema.productPhotos).values({ id: "photo", productId: "p", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/images/product-photos/thumb.webp", filename: "source.webp", storageKey: "source.webp", mimeType: "image/webp", sizeBytes: source.length, width: 100, height: 50 });
  await db.insert(schema.socialContents).values({ id: "content", productId: "p", contentType: "post", caption: "Human caption" });
  await db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
});
afterEach(async () => { vi.restoreAllMocks(); (db as any).$client.close(); await rm(root, { recursive: true, force: true }); });

it("prepares a selected Ready photo, persists provenance and leaves canonical data unchanged", async () => {
  const photos = await db.select().from(schema.productPhotos);
  const contents = await db.select().from(schema.socialContents);
  const result = await service().prepare("content", "photo", origin);
  expect(result).toMatchObject({ contentId: "content", sourcePhotoId: "photo", recipeVersion: "instagram-v1",
    sourceFingerprint: createHash("sha256").update("source.webp").update("\0").update(source).digest("hex") });
  expect(result.url).toBe(origin + result.outputPath);
  expect(await rows()).toEqual([expect.objectContaining({ id: result.id, outputPath: result.outputPath })]);
  expect(await sharp(await readFile(path.join(root, path.basename(result.outputPath)))).metadata()).toMatchObject({ format: "jpeg", width: 1080, height: 1080 });
  expect(await readFile(path.join(root, "source.webp"))).toEqual(source);
  expect(await db.select().from(schema.productPhotos)).toEqual(photos);
  expect(await db.select().from(schema.socialContents)).toEqual(contents);
  expect(fetch).not.toHaveBeenCalled();
});
it("reuses one row and derivative across retries and concurrent preparations", async () => {
  const results = await Promise.all([service().prepare("content", "photo", origin), service().prepare("content", "photo", origin)]);
  expect(results[0]).toEqual(results[1]);
  expect(await service().prepare("content", "photo", origin)).toEqual(results[0]);
  expect(await rows()).toHaveLength(1);
  expect((await readdir(root)).filter(name => name.endsWith(".jpg"))).toHaveLength(1);
});
it("rejects a non-selected photo before rendering", async () => {
  const renderer = vi.fn(render);
  await expect(service(renderer).prepare("content", "other", origin)).rejects.toThrow("not selected");
  expect(renderer).not.toHaveBeenCalled(); expect(await rows()).toHaveLength(0);
});
it("rejects non-Ready media before rendering", async () => {
  await db.update(schema.productPhotos).set({ processingStatus: "Processing" });
  const renderer = vi.fn(render);
  await expect(service(renderer).prepare("content", "photo", origin)).rejects.toThrow("must be ready");
  expect(renderer).not.toHaveBeenCalled(); expect(await rows()).toHaveLength(0);
});
it("rejects a photo belonging to a different selected product", async () => {
  await db.insert(schema.products).values({ id: "other", sku: "other", title: "other", slug: "other", type: "unique_item", status: "draft" });
  await db.update(schema.socialContents).set({ productId: "other" });
  await expect(service().prepare("content", "photo", origin)).rejects.toThrow("must be ready");
  expect(await rows()).toHaveLength(0);
});
it.each(["selection", "version", "Ready", "source"])("rejects stale %s before attachment", async (change) => {
  const renderer = async (photo: { url: string }, publicOrigin: string) => {
    const asset = await render(photo, publicOrigin);
    if (change === "selection") await db.update(schema.socialContentMedia).set({ id: "replacement" });
    if (change === "version") await db.update(schema.socialContents).set({ version: 2 });
    if (change === "Ready") await db.update(schema.productPhotos).set({ processingStatus: "Processing" });
    if (change === "source") await db.update(schema.productPhotos).set({ url: "/images/product-photos/other.webp" });
    return asset;
  };
  await expect(service(renderer).prepare("content", "photo", origin)).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
});
it("renderer failure persists no success and exposes no filesystem path", async () => {
  await writeFile(path.join(root, "source.webp"), "invalid image");
  try { await service().prepare("content", "photo", origin); throw new Error("Expected failure"); }
  catch (error) { expect(String(error)).not.toContain(root); expect(String(error)).not.toContain("Expected failure"); }
  expect(await rows()).toHaveLength(0);
});
it("retains source identity after ProductPhoto deletion", async () => {
  const result = await service().prepare("content", "photo", origin);
  await db.delete(schema.productPhotos).where(eq(schema.productPhotos.id, "photo"));
  expect(await rows()).toEqual([expect.objectContaining({ id: result.id, sourcePhotoId: "photo" })]);
  await expect(service().prepare("content", "photo", origin)).rejects.toThrow();
});
it("additive SQLite upgrade preserves existing content and selections and is repeatable", async () => {
  const client = (db as any).$client;
  client.exec("DROP TABLE social_prepared_images");
  const contents = await db.select().from(schema.socialContents);
  const media = await db.select().from(schema.socialContentMedia);
  ensureSchema(client); ensureSchema(client);
  expect(await rows()).toEqual([]);
  expect(await db.select().from(schema.socialContents)).toEqual(contents);
  expect(await db.select().from(schema.socialContentMedia)).toEqual(media);
});
