import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { createSocialContentPreparationService } from "../src/services/socialContentPreparation";
import { inspectPreparedInstagramImage, prepareInstagramImageAsset, type InstagramImageRecipe } from "../src/integrations/instagram/mediaPreparation";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
let db: ReturnType<typeof createTestDb>;
let root: string;
let artifact: Awaited<ReturnType<ReturnType<typeof createSocialContentPreparationService>["prepare"]>>;
const inspect: typeof inspectPreparedInstagramImage = (photo, prepared) => inspectPreparedInstagramImage(photo, prepared, root);
const renderer = vi.fn();
const service = (inspection = inspect) => createSocialContentPreparationService(db, "test-memory", renderer, inspection);
const validate = () => service().validatePreparedImageCurrent("content", artifact.id);
const output = () => path.join(root, path.basename(artifact.outputPath));
async function prepare(recipe: InstagramImageRecipe = "instagram-v1") {
  const render: typeof prepareInstagramImageAsset = (photo, origin, _env, _root, selected) => prepareInstagramImageAsset(photo, origin,
    { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" }, root, selected);
  return createSocialContentPreparationService(db, "test-memory", render).prepare("content", "photo", "https://api.example.test", recipe);
}
beforeEach(async () => {
  db = createTestDb(); root = await mkdtemp(path.join(tmpdir(), "social-validity-")); renderer.mockReset();
  renderer.mockRejectedValue(new Error("Validation must not render"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
  await writeFile(path.join(root, "source.webp"), await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).webp().toBuffer());
  await db.insert(schema.products).values({ id: "p", sku: "p", title: "p", slug: "p", type: "unique_item", status: "draft" });
  await db.insert(schema.productPhotos).values({ id: "photo", productId: "p", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/thumb.webp", filename: "source.webp", storageKey: "source.webp", mimeType: "image/webp", sizeBytes: 100, width: 100, height: 50 });
  await db.insert(schema.socialContents).values({ id: "content", productId: "p", contentType: "post" });
  await db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 });
  artifact = await prepare();
});
afterEach(async () => {
  expect(renderer).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(await db.select().from(schema.instagramPublishAttempts)).toEqual([]);
  vi.restoreAllMocks(); (db as any).$client.close();
  await rm(root, { recursive: true, force: true });
});

it.each(["instagram-v1", "instagram-portrait-v1"] as const)("validates current %s without any DB/file writes", async (recipe) => {
  artifact = await prepare(recipe);
  const client = (db as any).$client;
  const changes = () => client.prepare("SELECT total_changes() AS n").get().n;
  const before = changes();
  const names = await readdir(root);
  const snapshot = await Promise.all(names.map(async name => ({ bytes: await readFile(path.join(root, name)), mtime: (await stat(path.join(root, name))).mtimeMs })));
  const { url: _url, ...persisted } = artifact;
  expect(await validate()).toEqual({ preparedImage: persisted, contentVersion: 1 });
  expect(changes()).toBe(before); expect(await readdir(root)).toEqual(names);
  expect(await Promise.all(names.map(async name => ({ bytes: await readFile(path.join(root, name)), mtime: (await stat(path.join(root, name))).mtimeMs })))).toEqual(snapshot);
});
it("rejects a wrong content/artifact association", async () => {
  await expect(service().validatePreparedImageCurrent("other", artifact.id)).rejects.toBeInstanceOf(NotFoundError);
});
it("retains historical rows through deselection, then accepts unchanged reselection and reordered rows", async () => {
  await db.delete(schema.socialContentMedia);
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
  expect(await db.select().from(schema.socialPreparedImages)).toHaveLength(1);
  await db.insert(schema.socialContentMedia).values({ id: "new-selection", contentId: "content", photoId: "photo", sortOrder: 3 });
  await db.update(schema.socialContents).set({ version: 3 });
  expect((await validate()).contentVersion).toBe(3);
});
it.each(["not-ready", "deleted", "ownership"])("rejects %s source without deleting history", async (change) => {
  if (change === "not-ready") await db.update(schema.productPhotos).set({ processingStatus: "Processing" });
  if (change === "deleted") await db.delete(schema.productPhotos);
  if (change === "ownership") {
    await db.insert(schema.products).values({ id: "other", sku: "other", title: "other", slug: "other", type: "unique_item", status: "draft" });
    await db.update(schema.socialContents).set({ productId: "other" });
  }
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
  expect(await db.select().from(schema.socialPreparedImages)).toHaveLength(1);
});
it.each(["bytes", "filename", "missing-source"])("rejects changed %s", async (change) => {
  const file = path.join(root, "source.webp");
  if (change === "bytes") await writeFile(file, await sharp({ create: { width: 100, height: 50, channels: 3, background: "blue" } }).webp().toBuffer());
  if (change === "filename") {
    await rename(file, path.join(root, "renamed.webp"));
    await db.update(schema.productPhotos).set({ url: "/images/product-photos/renamed.webp", storageKey: "renamed.webp" });
  }
  if (change === "missing-source") await files.unlink(file);
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
});
it.each(["recipe", "path", "fingerprint"])("rejects mismatched persisted %s", async (change) => {
  await db.update(schema.socialPreparedImages).set(change === "recipe" ? { recipeVersion: "unsupported" } : change === "path" ? { outputPath: "/images/product-photos/../unsafe.jpg" } : { sourceFingerprint: "0".repeat(64) });
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
});
it.each(["missing", "corrupt", "dimensions"])("rejects %s derivative without repair", async (change) => {
  if (change === "missing") await files.unlink(output());
  if (change === "corrupt") await writeFile(output(), "corrupt");
  if (change === "dimensions") await writeFile(output(), await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).jpeg().toBuffer());
  const before = change === "missing" ? null : await readFile(output());
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
  if (before === null) await expect(stat(output())).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await readFile(output())).toEqual(before);
  expect(await db.select().from(schema.socialPreparedImages)).toHaveLength(1);
});
it.each(["version", "selection", "source", "Ready"])("detects concurrent %s changes", async (change) => {
  const inspection: typeof inspectPreparedInstagramImage = async (photo, prepared) => {
    const valid = await inspect(photo, prepared);
    if (change === "version") await db.update(schema.socialContents).set({ version: 2 });
    if (change === "selection") await db.update(schema.socialContentMedia).set({ id: "replacement" });
    if (change === "source") await db.update(schema.productPhotos).set({ storageKey: "replacement.webp" });
    if (change === "Ready") await db.update(schema.productPhotos).set({ processingStatus: "Processing" });
    return valid;
  };
  await expect(service(inspection).validatePreparedImageCurrent("content", artifact.id)).rejects.toBeInstanceOf(ConflictError);
});
it.each(["source.webp", "derivative"])("rejects unsafe symlink inspection for %s", async (target) => {
  const original = files.lstat;
  vi.spyOn(files, "lstat").mockImplementation(async (...args) => {
    const info = await original(...args);
    if (String(args[0]) === (target === "derivative" ? output() : path.join(root, target))) info.isSymbolicLink = () => true;
    return info;
  });
  await expect(validate()).rejects.toBeInstanceOf(BadRequestError);
});
it("sanitizes infrastructure failures", async () => {
  vi.spyOn(files, "lstat").mockRejectedValueOnce(Object.assign(new Error("private path and secret"), { code: "EACCES" }));
  await expect(validate()).rejects.toThrow(/^Prepared image validation failed$/);
});
