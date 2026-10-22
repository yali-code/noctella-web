/**
 * FAZ A #424 work package B: disk exhaustion on the fenced W2 path fails closed WITHOUT ending the request identity.
 * A mocked sharp toFile rejection uses libvips-style "No space left on device" text, so the production error mapping
 * (photoStorageError -> 503) and the W2 owner run unmodified. No actual full-disk/OS ENOSPC experiment. A deterministic
 * input rejection would put the operation in review; a transient storage failure must not. SQLite and disposable
 * PostgreSQL; no customer data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w2-enospc-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("fenced W2 under disk exhaustion on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {}, categoryId: string;
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (statement: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows);

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const harness = await createPostgresTestDb("0044_photo_publication_copies.sql");
      db = harness.db; close = () => harness.close();
    } else { delete process.env.DATABASE_DRIVER; db = createTestDb(); }
    categoryId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, ${"ENOSPC " + driver}, ${"enospc-" + categoryId}) RETURNING id`);
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("ENOSPC during encode: 503 storage-unavailable, operation NOT in review, nothing published; the same identity commits exactly once when space returns", async () => {
    const productId = randomUUID();
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"ENOSPC-" + productId}, 'Synthetic', ${"enospc-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    const bytes = await sharp({ create: { width: 110, height: 70, channels: 3, background: "#7a3d10" } }).jpeg().toBuffer();
    const token = `enospc-${driver}-${randomUUID().slice(0, 12)}`;
    const upload = async () => {
      const workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-enospc-input-"));
      await writeFile(path.join(workDir, "input"), bytes);
      const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
      try { return await uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver }); }
      finally { await rm(workDir, { recursive: true, force: true }); }
    };
    const op = async () => (await q(sql`SELECT state, generation, review_reason, committed_photo_id FROM photo_operations WHERE subject_id = ${token}`))[0];

    // Inject libvips-style full-disk text at the first encoder write (test-mode in-process preparation only).
    const spy = vi.spyOn((sharp as any).prototype, "toFile").mockRejectedValueOnce(new Error("VipsForeignSave: unable to write to target\nNo space left on device"));
    await expect(upload()).rejects.toMatchObject({ status: 503, code: "PHOTO_STORAGE_UNAVAILABLE" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const failed = await op();
    expect(failed.state).toBe("preparing"); // retryable: NOT review (an invalid image would have been review)
    expect(failed.review_reason).toBeNull();
    expect((await readdir(path.join(root, "photos")).catch(() => [])).filter((f) => f.startsWith(productId))).toEqual([]);

    await expect(upload()).rejects.toMatchObject({ code: "PHOTO_OPERATION_IN_PROGRESS" }); // the failed attempt's lease
    await q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${token} AND state IN ('preparing', 'sealed') RETURNING subject_id`);
    const photo = await upload();
    const done = await op();
    expect([done.state, Number(done.generation)]).toEqual(["committed", 2]);
    expect(photo.id).toBe(done.committed_photo_id);
    expect(Number((await q(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId}`))[0].n)).toBe(1);
    expect(Number((await q(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${photo.id}`))[0].n)).toBe(1);
  });
});
