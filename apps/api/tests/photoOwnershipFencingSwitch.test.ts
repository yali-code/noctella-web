import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { productPhotos, products } from "../src/db/schema";
import { OutboxEventType } from "../src/services/outbox";
import { ProductPhotoCleanupTempHandler, ProductPhotoDeleteHandler, ProductPhotoPromotionHandler } from "../src/services/productPhotoStorageWorkflow";
import { createProductPhotoOutboxDispatcher } from "../src/services/productPhotoOutboxDispatcher";
import { SqliteOutboxRepository } from "../src/services/outboxRepository";
import { OWNERSHIP_ROLLBACK_BLOCKERS_SQL, PhotoFencingRefusedError, ownershipRollbackBlockers, photoOwnershipFencingConfig, photoOwnershipFencingEnabled } from "../src/services/photoOwnershipFencing";
import { uploadProductPhoto, uploadStagedProductPhoto } from "../src/services/products";
import { prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";
import { buildDefaultDeps } from "../src/services/aiIntakeCleanup";
import { productPhotoStaticRoot } from "../src/services/photoStorage";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

// Photo ownership fencing switch (#396/#403/#407): migration 0040 / schema.sql registration and
// fail-closed refusals of every unadopted canonical writer/deleter when the switch is ON.

const OWNERSHIP_TABLES = ["photo_operation_artifacts", "photo_operation_generations", "photo_operations", "photo_storage_roots"];
const MIGRATION_0040 = fs.readFileSync(path.join(__dirname, "../src/db/postgres-migrations/0040_photo_operation_ownership.sql"), "utf8");
const product = { id: "p1", slug: "photo-product", sku: "SKU-PP", title: "Photo Product", type: ProductType.UniqueItem, status: ProductStatus.Published, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100 };
const tables = (sqlite: Database.Database) => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'photo_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), "noctella-photo-fencing-switch-")); });
afterEach(async () => { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }); });

describe("ownership migration (SQLite schema.sql via ensureSchema)", () => {
  it("creates the ownership tables on fresh databases and is idempotent", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    ensureSchema(sqlite);
    expect(tables(sqlite)).toEqual(OWNERSHIP_TABLES);
  });

  it("upgrades an existing database additively without touching photo, intake or outbox rows", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    for (const t of ["photo_operation_artifacts", "photo_operation_generations", "photo_operations", "photo_storage_roots"]) sqlite.exec(`DROP TABLE ${t}`); // pre-upgrade state
    sqlite.prepare("INSERT INTO products(id,sku,title,slug,type,status) VALUES('p1','S','T','t','unique_item','draft')").run();
    sqlite.prepare("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key) VALUES('ph','p1','/images/product-photos/a.webp','/images/product-photos/a-thumb.webp','a.webp','image/webp',1,1,1,'a.webp','a-thumb.webp')").run();
    sqlite.prepare("INSERT INTO ai_intake_photos(id,intake_id,storage_key,original_filename,created_by_admin_user_id) VALUES('i','in','k.webp','k.png','u')").run();
    sqlite.prepare("INSERT INTO outbox_events(id,event_type,aggregate_type,idempotency_key,payload,status,available_at) VALUES('e','product_photo.promote_requested','ProductPhoto','k','{}','completed','2026-01-01')").run();
    const snapshot = () => JSON.stringify(["product_photos", "ai_intake_photos", "outbox_events"].map((t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
    const before = snapshot();
    ensureSchema(sqlite);
    expect(tables(sqlite)).toEqual(OWNERSHIP_TABLES);
    expect(snapshot()).toBe(before);
  });

  it("refuses rollback while operations are preparing, sealed or under review", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    expect(ownershipRollbackBlockers(sqlite.prepare(OWNERSHIP_ROLLBACK_BLOCKERS_SQL).all() as never)).toEqual({ safe: true, blockers: {} });
    const op = (id: string, state: string) => sqlite.prepare("INSERT INTO photo_operations(id,kind,subject_type,subject_id,target_photo_id,main_key,thumb_key,input_sha256,generation,owner,nonce,state,lease_until_ms,created_ms,updated_ms) VALUES(?,'ai_finalize','ai_intake_photos',?,?,?,?,'x',1,'o','n',?,0,0,0)").run(id, id, id, `${id}.webp`, `${id}-t.webp`, state);
    op("a", "committed"); op("b", "sealed"); op("c", "review");
    expect(ownershipRollbackBlockers(sqlite.prepare(OWNERSHIP_ROLLBACK_BLOCKERS_SQL).all() as never)).toEqual({ safe: false, blockers: { review: 1, sealed: 1 } });
    expect(() => ownershipRollbackBlockers([{ state: "sealed", n: "x" }])).toThrow("PHOTO_OWNERSHIP_ROLLBACK_STATE_UNREADABLE");
  });
});

describe.skipIf(!postgresTestConfigured)("ownership migration 0040 (PostgreSQL)", () => {
  it("applies over 0038 with existing rows, is idempotent, and a failing batch leaves no partial schema", async () => {
    const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql");
    try {
      await h.pool.query("INSERT INTO products(id,sku,title,slug,type,status) VALUES('p1','S','T','t','unique_item','draft')");
      await h.pool.query("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key) VALUES('ph','p1','/images/product-photos/a.webp','/images/product-photos/a-thumb.webp','a.webp','image/webp',1,1,1,'a.webp','a-thumb.webp')");
      const before = JSON.stringify((await h.pool.query("SELECT * FROM product_photos ORDER BY id")).rows);
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(`${MIGRATION_0040}\nSELECT * FROM missing_table_0040;`)).rejects.toThrow();
        await client.query("ROLLBACK");
      } finally { client.release(); }
      const count = async () => Number((await h.pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'photo_%'")).rows[0].n);
      expect(await count()).toBe(0);
      await h.pool.query(MIGRATION_0040);
      await h.pool.query(MIGRATION_0040);
      expect(await count()).toBe(4);
      expect(JSON.stringify((await h.pool.query("SELECT * FROM product_photos ORDER BY id")).rows)).toBe(before);
      expect(ownershipRollbackBlockers((await h.pool.query(OWNERSHIP_ROLLBACK_BLOCKERS_SQL)).rows)).toEqual({ safe: true, blockers: {} });
    } finally { await h.close(); }
  });
});

describe("PHOTO_OWNERSHIP_FENCING_ENABLED fail-closed refusals", () => {
  it("is OFF only for unset, empty or 'false'; invalid values are reported and fail closed (ON)", () => {
    for (const value of [undefined, "", "false"]) expect(photoOwnershipFencingConfig({ PHOTO_OWNERSHIP_FENCING_ENABLED: value } as NodeJS.ProcessEnv)).toMatchObject({ enabled: false, valid: true });
    expect(photoOwnershipFencingConfig({ PHOTO_OWNERSHIP_FENCING_ENABLED: "true" } as NodeJS.ProcessEnv)).toMatchObject({ enabled: true, valid: true });
    for (const value of ["1", "TRUE", "yes", "true ", "False"]) expect(photoOwnershipFencingConfig({ PHOTO_OWNERSHIP_FENCING_ENABLED: value } as NodeJS.ProcessEnv)).toMatchObject({ enabled: true, valid: false });
    expect(photoOwnershipFencingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("W1/W2 (and W10): uploads refuse with 503 before any storage write", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    const sqlite = new Database(":memory:"); ensureSchema(sqlite); const db = drizzle(sqlite, { schema });
    await db.insert(products).values(product);
    const storage = { saveProductPhoto: vi.fn(), deleteProductPhoto: vi.fn() };
    await expect(uploadProductPhoto(db as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, storage as never)).rejects.toMatchObject({ status: 503, code: "PHOTO_FENCING_WRITER_NOT_ADOPTED" });
    const staged = { saveStagedProductPhoto: vi.fn(), deleteProductPhoto: vi.fn() };
    await expect(uploadStagedProductPhoto(db as never, "p1", { path: "x", workDir: "y", mimetype: "image/png", size: 1, signal: new AbortController().signal }, undefined, staged as never)).rejects.toMatchObject({ status: 503 });
    expect(storage.saveProductPhoto).not.toHaveBeenCalled(); expect(storage.deleteProductPhoto).not.toHaveBeenCalled(); expect(staged.saveStagedProductPhoto).not.toHaveBeenCalled();
    expect(await db.select().from(productPhotos)).toHaveLength(0);
  });

  it("W8/W9: outbox delete and temp cleanup refuse permanently and keep the canonical bytes", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    const roots = { tempRoot: root, permanentRoot: root };
    for (const f of ["a.webp", "a-thumb.webp"]) fs.writeFileSync(path.join(root, f), f);
    const event = (eventType: OutboxEventType) => ({ id: "e", eventType, aggregateType: "ProductPhoto", aggregateId: "ph", payload: { storageKey: "a.webp", thumbnailStorageKey: "a-thumb.webp" } }) as never;
    for (const handler of [new ProductPhotoDeleteHandler(roots), new ProductPhotoCleanupTempHandler(roots)]) {
      const error = await handler.handle(event(handler.eventType)).catch((e) => e);
      expect(error).toBeInstanceOf(PhotoFencingRefusedError);
      expect(error.permanent).toBe(true);
    }
    expect(fs.readdirSync(root).sort()).toEqual(["a-thumb.webp", "a.webp"]);
  });

  it("W8 with the switch OFF: keyless production events are not falsely acknowledged; keyed deletes need an authoritative unreferenced check", async () => {
    const roots = { tempRoot: root, permanentRoot: root };
    for (const f of ["a.webp", "a-thumb.webp"]) fs.writeFileSync(path.join(root, f), f);
    const keyed = { id: "e", eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", aggregateId: "ph", payload: { storageKey: "a.webp", thumbnailStorageKey: "a-thumb.webp" } };
    // The real emitter (deleteProductPhoto) sends only photoId/productId.
    await expect(new ProductPhotoDeleteHandler(roots, async () => false).handle({ ...keyed, payload: { photoId: "ph", productId: "p1" } } as never)).rejects.toMatchObject({ code: "PHOTO_DELETE_KEYS_ABSENT", permanent: true });
    await expect(new ProductPhotoDeleteHandler(roots).handle(keyed as never)).rejects.toMatchObject({ code: "PHOTO_DELETE_REFERENCE_UNKNOWN" });
    await expect(new ProductPhotoDeleteHandler(roots, async (key) => key === "a-thumb.webp").handle(keyed as never)).rejects.toMatchObject({ code: "PHOTO_DELETE_KEY_REFERENCED" });
    await expect(new ProductPhotoDeleteHandler(roots, async () => { throw new Error("db down"); }).handle(keyed as never)).rejects.toThrow("db down");
    expect(fs.readdirSync(root).sort()).toEqual(["a-thumb.webp", "a.webp"]);
    await new ProductPhotoDeleteHandler(roots, async () => false).handle(keyed as never);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("W8 dispatcher wiring: a stale delete event for a key a newer photo row references is dead-lettered, not executed", async () => {
    const sqlite = new Database(":memory:"); ensureSchema(sqlite); const db = drizzle(sqlite, { schema });
    await db.insert(products).values(product);
    await db.insert(productPhotos).values({ id: "newer", productId: "p1", url: "/images/product-photos/k.webp", thumbnailUrl: "/images/product-photos/k-thumb.webp", filename: "k.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1, processingStatus: "Ready", storageKey: "k.webp", thumbnailStorageKey: "k-thumb.webp", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as never);
    for (const f of ["k.webp", "k-thumb.webp"]) fs.writeFileSync(path.join(root, f), f);
    const outbox = new SqliteOutboxRepository(sqlite);
    await outbox.create({ id: "stale-delete", eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", idempotencyKey: "stale", payload: { photoId: "old", storageKey: "k.webp", thumbnailStorageKey: "k-thumb.webp" }, maxAttempts: 3, availableAt: "2026-01-01" } as never);
    await createProductPhotoOutboxDispatcher(db as never, "sqlite", { tempRoot: root, permanentRoot: root }).dispatchDueEvents("w", 5);
    expect((await outbox.getById("stale-delete"))?.lastErrorCode).toBe("PHOTO_DELETE_KEY_REFERENCED");
    expect(fs.readdirSync(root).sort()).toEqual(["k-thumb.webp", "k.webp"]);
  });

  it("W9 never deletes in the canonical root", async () => {
    fs.writeFileSync(path.join(root, "t.webp"), "t");
    await expect(new ProductPhotoCleanupTempHandler({ tempRoot: root, permanentRoot: root }).handle({ id: "e", eventType: OutboxEventType.ProductPhotoCleanupTempRequested, aggregateType: "ProductPhoto", payload: { storageKey: "t.webp" } } as never)).rejects.toMatchObject({ code: "PHOTO_TEMP_ROOT_IS_CANONICAL" });
    expect(fs.readdirSync(root)).toEqual(["t.webp"]);
  });

  it("W7: distinct-root promotion refuses without copying or unlinking", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    const sqlite = new Database(":memory:"); ensureSchema(sqlite); const db = drizzle(sqlite, { schema });
    await db.insert(products).values(product);
    await db.insert(productPhotos).values({ id: "ph", productId: "p1", url: "/images/product-photos/a.webp", thumbnailUrl: "/images/product-photos/a-thumb.webp", filename: "a.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1, processingStatus: "Processing", storageKey: "a.webp", thumbnailStorageKey: "a-thumb.webp", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as never);
    const tempRoot = path.join(root, "tmp"), permanentRoot = path.join(root, "perm");
    fs.mkdirSync(tempRoot); fs.mkdirSync(permanentRoot);
    for (const f of ["a.webp", "a-thumb.webp"]) fs.writeFileSync(path.join(tempRoot, f), f);
    const uow = { run: async (fn: (x: unknown) => unknown) => fn({ repositories: { db } }) };
    await expect(new ProductPhotoPromotionHandler(uow as never, { tempRoot, permanentRoot }).handle({ id: "e", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", aggregateId: "ph", payload: { photoId: "ph" } } as never)).rejects.toBeInstanceOf(PhotoFencingRefusedError);
    expect(fs.readdirSync(permanentRoot)).toEqual([]);
    expect(fs.readdirSync(tempRoot).sort()).toEqual(["a-thumb.webp", "a.webp"]);
  });

  it("W6: AI cleanup canonical deletion refuses; private (non-canonical) deletion is unaffected", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    const sqlite = new Database(":memory:"); ensureSchema(sqlite);
    const deps = buildDefaultDeps(drizzle(sqlite, { schema }) as never);
    const name = `fencing-probe-${Date.now()}.webp`;
    fs.mkdirSync(productPhotoStaticRoot, { recursive: true });
    const canonical = path.join(productPhotoStaticRoot, name);
    fs.writeFileSync(canonical, "keep");
    try {
      await expect(deps.deleteCanonicalFile(name)).rejects.toBeInstanceOf(PhotoFencingRefusedError);
      expect(fs.existsSync(canonical)).toBe(true);
    } finally { fs.rmSync(canonical, { force: true }); }
  });

  it("W11: Instagram preparation refuses (retryable) without writing into the canonical root", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    fs.writeFileSync(path.join(root, "a.webp"), "x");
    await expect(prepareInstagramImageAsset({ url: "/images/product-photos/a.webp" }, "https://example.test", process.env, root)).rejects.toMatchObject({ kind: "processing", retryable: true });
    expect(fs.readdirSync(root)).toEqual(["a.webp"]);
  });
});
