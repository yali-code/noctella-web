import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { selectNextSocialContentCandidate } from "../src/services/socialContentSelection";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => { db = createTestDb(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call")); });
afterEach(() => { vi.restoreAllMocks(); (db as any).$client.close(); });
const select = () => selectNextSocialContentCandidate(db, "test-memory");
async function product(id: string, ready = 1, status = "draft") {
  await db.insert(schema.products).values({ id, sku: id, title: id, slug: id, type: "unique_item", status });
  for (let i = 0; i < ready; i++) await photo(id, `${id}-${i}`, "Ready");
}
async function photo(productId: string, id: string, processingStatus: string) {
  await db.insert(schema.productPhotos).values({ id, productId, processingStatus, url: `/${id}.webp`, thumbnailUrl: `/${id}-thumb.webp`, filename: `${id}.webp`, mimeType: "image/webp", sizeBytes: 10, width: 100, height: 100 });
}
async function content(productId: string, id: string, status = "rejected", updatedAt = "2026-09-01T00:00:00.000Z", aiSourceProductId?: string) {
  await db.insert(schema.socialContents).values({ id, productId, contentType: "post", status, updatedAt, aiSourceProductId });
}

it("excludes missing/non-Ready media and selects a canonical product with Ready media", async () => {
  await product("a", 0); await photo("a", "pending", "Processing");
  expect(await select()).toBeNull();
  await product("b");
  expect(await select()).toEqual({ productId: "b", title: "b", readyPhotoCount: 1, latestSocialActivityAt: null, latestSocialStatus: null, reason: "never_used" });
});
it.each(["archived", "sold", "reserved", "returned"])("excludes %s stock", async (status) => {
  await product("a", 2, status); expect(await select()).toBeNull();
});
it.each(["draft", "ready_for_review", "approved"])("blocks %s work even when later rejected history exists", async (status) => {
  await product("a"); await content("a", "active", status); await content("a", "later", "rejected", "2026-09-02T00:00:00.000Z");
  expect(await select()).toBeNull();
});
it("prefers never-used over older used products regardless of media count", async () => {
  await product("used", 3); await content("used", "old"); await product("new");
  expect(await select()).toMatchObject({ productId: "new", reason: "never_used" });
});
it("uses latest activity per product and ranks the oldest latest activity first", async () => {
  await product("a", 3); await product("b");
  await content("a", "old", "rejected", "2026-08-01 00:00:00");
  await content("a", "new", "rejected", "2026-09-03T00:00:00.000Z");
  await content("b", "middle", "rejected", "2026-09-02 00:00:00");
  expect(await select()).toMatchObject({ productId: "b", latestSocialActivityAt: "2026-09-02T00:00:00.000Z", latestSocialStatus: "rejected", reason: "oldest_activity" });
});
it("prefers more Ready photos at equal recency, then stable product ID", async () => {
  await product("b", 2); await product("a", 1); await photo("a", "not-ready", "Processing");
  expect(await select()).toMatchObject({ productId: "b" });
  await photo("a", "ready", "Ready");
  expect(await select()).toMatchObject({ productId: "a" });
  await content("a", "ca"); await content("b", "cb");
  expect(await select()).toMatchObject({ productId: "a" });
});
it("tracks immutable generation source as well as current product ownership", async () => {
  await product("a"); await product("b"); await content("b", "moved", "draft", undefined, "a");
  expect(await select()).toBeNull();
});
it("is repeatable and read-only with no draft creation or provider work", async () => {
  await product("a");
  const client = (db as any).$client;
  const before = client.prepare("SELECT total_changes() AS n").get().n;
  const first = await select(); expect(await select()).toEqual(first);
  expect(client.prepare("SELECT total_changes() AS n").get().n).toBe(before);
  expect(await db.select().from(schema.socialContents)).toEqual([]);
  expect(await db.select().from(schema.socialContentMedia)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
