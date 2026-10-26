/**
 * S1-b routing pin for the in-process fenced W4 owner (PHOTO_OWNERSHIP_FENCING_ENABLED=true, confinement unset under
 * NODE_ENV=test = "in-process-unprotected"; not reachable in production): a format-rejected staged source follows
 * EXACTLY the routing of the pre-S1-b invalid-media rejection on this path (validateUpload's BadRequestError, here an
 * oversize source): same HTTP mapping, photo_operations stays 'preparing' (never 'review'), no product photo, no outbox
 * event, intake stays Applied, and a later re-request after lease expiry reclaims the operation in both cases.
 * Real SQLite, real W4 finalization service and owner, real recipe.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql, type SQL } from "drizzle-orm";
import { AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w4-s1b-routing-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  delete process.env.PHOTO_PREPARATION_CONFINEMENT;
  return { root };
});

import { createTestDb } from "./testDb";
import { finalizeAiIntakePhotos } from "../src/services/aiIntakePhotoFinalization";
import { photoPreparationConfinementConfig } from "../src/services/photoPreparationConfinement";
import { handleRouteError } from "../src/routes/errorHandler";
import { BadRequestError } from "../src/services/errors";
import { ALLOWED_IMAGE_FORMAT_MESSAGE, ImageFormatRejectedError } from "../src/services/imageFormatGuard";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { sharp.cache(false); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

describe("in-process fenced W4: format rejection routes exactly like the existing invalid-media rejection", () => {
  let db: any, categoryId: string;
  const sources = new Map<string, Buffer>();
  const q = (statement: SQL): any[] => db.all(statement);
  const n = (statement: SQL) => Number(q(statement)[0].n);
  const legacyWriter = vi.fn(async () => { throw new Error("the unfenced canonical writer must never run with fencing ON"); });
  const deps = { readStagedPhotoBytes: async (id: string) => sources.get(id)!, writeDeterministicPhoto: legacyWriter as any };
  const finalize = (intakeId: string) => finalizeAiIntakePhotos(db, intakeId, {}, "admin-finalizer", deps, { driver: "sqlite" });

  beforeAll(() => {
    db = createTestDb();
    categoryId = randomUUID();
    q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, 'S1-b routing', ${"s1b-" + categoryId}) RETURNING id`);
  });

  /** An Applied intake with one staged photo under a legacy `${uuid}.webp` key whose bytes are `source`. */
  function appliedIntake(source: Buffer) {
    const productId = randomUUID(), intakeId = randomUUID(), stagedId = randomUUID();
    q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"S1B-" + productId}, 'Synthetic', ${"s1b-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    q(sql`INSERT INTO ai_product_intakes (id, status, created_by_admin_user_id, result_product_id, applied_at, applied_by_admin_user_id) VALUES (${intakeId}, ${AiProductIntakeStatus.Applied}, 'admin-1', ${productId}, ${new Date().toISOString()}, 'admin-1') RETURNING id`);
    sources.set(stagedId, source);
    q(sql`INSERT INTO ai_intake_photos (id, intake_id, storage_key, original_filename, created_by_admin_user_id, created_at, updated_at) VALUES (${stagedId}, ${intakeId}, ${randomUUID() + ".webp"}, 'photo.webp', 'admin-1', ${new Date().toISOString()}, ${new Date().toISOString()}) RETURNING id`);
    return { productId, intakeId, stagedId };
  }

  /** Everything the routing decides: thrown type, HTTP mapping, operation state, side effects, and the re-request. */
  async function route(source: Buffer) {
    const { productId, intakeId, stagedId } = appliedIntake(source);
    const error = await finalize(intakeId).then(() => null, (e) => e);
    const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    handleRouteError(error, res);
    const op = () => q(sql`SELECT state, generation, review_reason FROM photo_operations WHERE subject_id = ${stagedId}`)[0];
    const first = op();
    const sideEffects = [
      n(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId}`),
      n(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id IN (SELECT id FROM product_photos WHERE product_id = ${productId})`),
      q(sql`SELECT status FROM ai_product_intakes WHERE id = ${intakeId}`)[0].status,
    ];
    // Re-request after the lease expired: an operation left 'preparing' is reclaimed (new generation), a 'review' one is 409.
    q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${stagedId} AND state IN ('preparing', 'sealed') RETURNING id`);
    const again = await finalize(intakeId).then(() => null, (e) => e);
    return {
      error, routing: {
        errorType: error?.constructor === ImageFormatRejectedError || error?.constructor === BadRequestError ? "BadRequestError" : error?.constructor?.name,
        hasStatus: error != null && "status" in error, http: res.statusCode, retryAfter: res.headers["Retry-After"] ?? null,
        state: first?.state, generation: Number(first?.generation), reviewReason: first?.review_reason ?? null, sideEffects,
        reRequest: { errorType: again?.constructor === ImageFormatRejectedError || again?.constructor === BadRequestError ? "BadRequestError" : again?.constructor?.name, state: op()?.state, generation: Number(op()?.generation) },
      },
    };
  }

  it("is the in-process mode under test (not confined), with fencing ON", () => {
    expect(photoPreparationConfinementConfig()).toEqual({ mode: "in-process-unprotected" });
  });

  it("before == after: a disguised GIF routes exactly like the pre-S1-b oversize invalid-media rejection", async () => {
    const baseline = await route(Buffer.alloc(10 * 1024 * 1024 + 1, 0xff)); // validateUpload BadRequestError (pre-S1-b)
    const rejected = await route(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } }).gif().toBuffer());
    expect(baseline.error).toBeInstanceOf(BadRequestError);
    expect(rejected.error).toBeInstanceOf(ImageFormatRejectedError);
    expect(rejected.error.message).toBe(ALLOWED_IMAGE_FORMAT_MESSAGE);
    expect(rejected.routing).toEqual(baseline.routing);
    // The pinned routing itself (documents the table): HTTP 400, never reviewed, no photo/outbox, reclaimable.
    expect(rejected.routing).toEqual({
      errorType: "BadRequestError", hasStatus: false, http: 400, retryAfter: null,
      state: "preparing", generation: 1, reviewReason: null, sideEffects: [0, 0, AiProductIntakeStatus.Applied],
      reRequest: { errorType: "BadRequestError", state: "preparing", generation: 2 },
    });
    expect(legacyWriter).not.toHaveBeenCalled();
  });
});
