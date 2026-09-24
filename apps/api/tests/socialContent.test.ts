import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { eq, getTableColumns } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import * as pg from "../src/db/schema.postgres";
import { createSocialContentService } from "../src/services/socialContent";
import { createSocialContentRouter } from "../src/routes/socialContent";
import { createAdminUser, login } from "../src/services/adminAuth";

let db: ReturnType<typeof createTestDb>;
let service: ReturnType<typeof createSocialContentService>;
const draft = { productId: "p1", mediaIds: ["photo1", "photo2"], caption: "A piece for the collection.", contentType: "post" };
beforeEach(async () => {
  db = createTestDb(); service = createSocialContentService(db, "test-memory");
  for (const id of ["p1", "p2"]) {
    await db.insert(schema.products).values({ id, sku: id, title: `Product ${id}`, slug: id, type: "unique_item", status: "draft" });
  }
  for (const [id, productId] of [["photo1", "p1"], ["photo2", "p1"], ["other", "p2"]]) {
    await db.insert(schema.productPhotos).values({ id, productId, url: `/images/product-photos/${id}.webp`, thumbnailUrl: `/images/product-photos/${id}-thumb.webp`, filename: `${id}.webp`, mimeType: "image/webp", sizeBytes: 100, width: 200, height: 200 });
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close(); });

describe("Social Content editorial foundation", () => {
  it("creates a durable draft with fixed platform/account and ordered canonical media references", async () => {
    const row = await service.create({ ...draft, mediaIds: ["photo2", "photo1"] });
    expect(row).toMatchObject({ platform: "instagram", accountLabel: "vault", status: "draft", version: 1, productId: "p1" });
    expect(row.media.map((photo) => photo.id)).toEqual(["photo2", "photo1"]);
    expect(await createSocialContentService(db).get(row.id)).toEqual(row);
    expect(await db.select().from(schema.socialContentMedia)).toHaveLength(2);
  });
  it("allows an empty draft with no product but does not submit incomplete content", async () => {
    const row = await service.create({});
    expect(row).toMatchObject({ status: "draft", productId: null, caption: "", media: [] });
    await expect(service.transition(row.id, { status: "ready_for_review", expectedVersion: 1 })).rejects.toThrow("caption and at least one photo");
  });
  it.each([{ platform: "pinterest" }, { accountLabel: "atelier" }, { status: "approved" }, { imageUrl: "https://evil.test/a.jpg" }, { mediaIds: ["../file"] }, { caption: "x".repeat(2201) }, { contentType: "video" }, { mediaIds: ["photo1", "photo1"] }])("rejects unsafe or unsupported draft input %j", async (invalid) => {
    await expect(service.create({ ...draft, ...invalid })).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  });
  it.each([{ productId: "missing" }, { mediaIds: ["missing"] }, { mediaIds: ["other"] }])("rejects invalid product/media ownership %j", async (invalid) => {
    await expect(service.create({ ...draft, ...invalid })).rejects.toThrow();
    expect(await db.select().from(schema.socialContents)).toHaveLength(0);
  });
  it("rejects media still processing", async () => {
    await db.update(schema.productPhotos).set({ processingStatus: "Processing" }).where(eq(schema.productPhotos.id, "photo1"));
    await expect(service.create(draft)).rejects.toThrow("must be ready");
  });
  it("edits drafts atomically and rejects a stale editor or invalid replacement", async () => {
    const row = await service.create(draft);
    const edited = await service.edit(row.id, { ...draft, caption: "Edited", mediaIds: ["photo2"], expectedVersion: 1 });
    expect(edited).toMatchObject({ caption: "Edited", status: "draft", version: 2 });
    expect(edited.media.map((photo) => photo.id)).toEqual(["photo2"]);
    await expect(service.edit(row.id, { ...draft, expectedVersion: 1 })).rejects.toThrow("Content changed");
    await expect(service.edit(row.id, { ...draft, mediaIds: ["other"], expectedVersion: 2 })).rejects.toThrow();
    expect(await service.get(row.id)).toEqual(edited);
  });
  it("explicitly submits and approves without touching products, photos, outbox or Instagram", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
    const before = await db.select().from(schema.productPhotos);
    const beforeProducts = await db.select().from(schema.products);
    let row = await service.create(draft);
    await expect(service.transition(row.id, { status: "approved", expectedVersion: 1 })).rejects.toThrow("Invalid social content transition");
    row = await service.transition(row.id, { status: "ready_for_review", expectedVersion: row.version });
    await expect(service.edit(row.id, { ...draft, expectedVersion: row.version })).rejects.toThrow("Only draft");
    await expect(service.transition(row.id, { status: "approved", expectedVersion: 1 })).rejects.toThrow("Content changed");
    row = await service.transition(row.id, { status: "approved", expectedVersion: row.version });
    expect(row.status).toBe("approved");
    await expect(service.edit(row.id, { ...draft, expectedVersion: row.version })).rejects.toThrow("Only draft");
    await expect(service.transition(row.id, { status: "draft", expectedVersion: row.version })).rejects.toThrow("Invalid social content transition");
    expect(await db.select().from(schema.instagramPublishAttempts)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
    expect(await db.select().from(schema.productPhotos)).toEqual(before);
    expect(await db.select().from(schema.products)).toEqual(beforeProducts);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("blocks approval after a selected canonical photo is deleted", async () => {
    let row = await service.create(draft);
    row = await service.transition(row.id, { status: "ready_for_review", expectedVersion: 1 });
    await db.delete(schema.productPhotos).where(eq(schema.productPhotos.id, "photo1"));
    expect(await service.get(row.id)).toMatchObject({ missingMediaCount: 1 });
    await expect(service.transition(row.id, { status: "approved", expectedVersion: row.version })).rejects.toThrow("no longer available");
    row = await service.transition(row.id, { status: "rejected", expectedVersion: row.version });
    row = await service.transition(row.id, { status: "draft", expectedVersion: row.version });
    row = await service.edit(row.id, { ...draft, mediaIds: ["photo2"], expectedVersion: row.version });
    expect(row.missingMediaCount).toBe(0);
    expect((await service.transition(row.id, { status: "ready_for_review", expectedVersion: row.version })).status).toBe("ready_for_review");
  });
  it("supports explicit rejection and return to draft", async () => {
    let row = await service.create(draft);
    row = await service.transition(row.id, { status: "ready_for_review", expectedVersion: row.version });
    row = await service.transition(row.id, { status: "rejected", expectedVersion: row.version });
    await expect(service.edit(row.id, { ...draft, expectedVersion: row.version })).rejects.toThrow("Only draft");
    row = await service.transition(row.id, { status: "draft", expectedVersion: row.version });
    expect(row.status).toBe("draft");
  });
  it("rejects competing transitions using the reviewed version", async () => {
    let row = await service.create(draft);
    row = await service.transition(row.id, { status: "ready_for_review", expectedVersion: 1 });
    const results = await Promise.allSettled([service.transition(row.id, { status: "approved", expectedVersion: row.version }), service.transition(row.id, { status: "rejected", expectedVersion: row.version })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("rolls caption and media changes back if a media insert fails", async () => {
    const row = await service.create(draft);
    (db as any).$client.exec("CREATE TRIGGER fail_social_media BEFORE INSERT ON social_content_media BEGIN SELECT RAISE(ABORT, 'forced media failure'); END");
    await expect(service.edit(row.id, { ...draft, caption: "Must rollback", expectedVersion: 1 })).rejects.toThrow();
    expect(await service.get(row.id)).toEqual(row);
  });
  it("filters and paginates content by type and status", async () => {
    await service.create(draft);
    const reel = await service.create({ ...draft, contentType: "reel" });
    await service.transition(reel.id, { status: "ready_for_review", expectedVersion: 1 });
    expect((await service.list({ status: "ready_for_review", contentType: "reel" })).items.map((row) => row.id)).toEqual([reel.id]);
    expect(await service.list({ pageSize: 1 })).toMatchObject({ hasMore: true });
    expect((await service.list({ pageSize: 1, page: 2 })).items).toHaveLength(1);
  });
  it("maintains schema column parity with an additive PostgreSQL migration", () => {
    for (const table of ["socialContents", "socialContentMedia"] as const) {
      expect(Object.values(getTableColumns(schema[table])).map((column) => column.name)).toEqual(Object.values(getTableColumns(pg[table])).map((column) => column.name));
    }
    const migration = readFileSync(new URL("../src/db/postgres-migrations/0029_social_manager_foundation.sql", import.meta.url), "utf8");
    expect(migration).not.toMatch(/^\s*(DROP|ALTER|TRUNCATE|DELETE\s+FROM|UPDATE)\b/im);
    expect(migration).toContain("REFERENCES product_photos(id)");
    expect(migration).toContain("TIMESTAMPTZ");
  });
  it("enforces non-null editorial IDs in SQLite like PostgreSQL primary keys", async () => {
    const client = (db as any).$client;
    expect(() => client.prepare("INSERT INTO social_contents (id, content_type) VALUES (NULL, 'post')").run()).toThrow(/NOT NULL/);
    const row = await service.create(draft);
    expect(() => client.prepare("INSERT INTO social_content_media (id, content_id, photo_id, sort_order) VALUES (NULL, ?, 'photo1', 99)").run(row.id)).toThrow(/NOT NULL/);
  });
});

describe("Social Content Admin API", () => {
  it("requires authentication and rejects forged roles and foreign origins", async () => {
    const app = express(); app.use(express.json()); app.use("/social", createSocialContentRouter(db));
    expect((await request(app).get("/social").set("x-admin-role", "owner")).status).toBe(401);
    expect((await request(app).post("/social").send(draft)).status).toBe(401);
    expect((await request(app).patch("/social/id").send(draft)).status).toBe(401);
    expect((await request(app).post("/social/id/status").send({ status: "approved" })).status).toBe(401);
    vi.stubEnv("ADMIN_APP_ORIGIN", "https://admin.example.test");
    expect((await request(app).post("/social").set("Origin", "https://evil.test").send(draft)).status).toBe(403);
  });
  it("allows product editors to draft but requires publish permission for human approval", async () => {
    const app = express(); app.use(express.json()); app.use("/social", createSocialContentRouter(db));
    await createAdminUser(db, { email: "editor@example.test", password: "safe-test-password-123", role: "product_editor" });
    const session = await login(db, { email: "editor@example.test", password: "safe-test-password-123" });
    const cookie = `noctella_admin_session=${session.rawToken}`;
    const created = await request(app).post("/social").set("Cookie", cookie).send(draft);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).get(`/social/${id}`).set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).post(`/social/${id}/status`).set("Cookie", cookie).send({ status: "ready_for_review", expectedVersion: 1 })).status).toBe(200);
    expect((await request(app).post(`/social/${id}/status`).set("Cookie", cookie).send({ status: "approved", expectedVersion: 2 })).status).toBe(403);
    expect((await request(app).post("/social").set("Cookie", cookie).send({ ...draft, mediaUrl: "file:///secret" })).status).toBe(400);
    await createAdminUser(db, { email: "owner@example.test", password: "safe-test-password-123", role: "owner" });
    const owner = await login(db, { email: "owner@example.test", password: "safe-test-password-123" });
    const approved = await request(app).post(`/social/${id}/status`).set("Cookie", `noctella_admin_session=${owner.rawToken}`).send({ status: "approved", expectedVersion: 2 });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(JSON.stringify(approved.body)).not.toContain("token");
  });
});
