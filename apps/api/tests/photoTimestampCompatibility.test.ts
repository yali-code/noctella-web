import { describe, expect, it } from "vitest";
import { photoTimestampValues, photoTimestampRecord, photoTimestampFields, intakeTimestampFields, photoOutboxTimestampFields } from "../src/repositories/photoTimestamps";
import * as postgres from "../src/db/schema.postgres";
import * as sqlite from "../src/db/schema.sqlite";
import { createDrizzleAiProductIntakeRepository, applyIntakeWithExpectedStateInTransaction, finalizeIntakeWithExpectedStateInTransaction } from "../src/repositories/ai-product-intake/drizzle";
import { createDrizzleAiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/drizzle";
import { createProductPhotoWithPromotionOutboxInTransaction } from "../src/repositories/product-write/drizzle";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { createTestDb } from "./testDb";
import { eq } from "drizzle-orm";
const iso = "2026-01-01T00:00:00.123Z";
describe("photo timestamp boundary", () => {
  it.each(["2025-12-31T19:00:00.123-05:00", "2026-01-01T03:00:00.123+03:00", iso])("preserves UTC instant at year boundary: %s", value => {
    const values = photoTimestampValues({ createdAt: value, unrelated: value }, photoTimestampFields, true);
    expect((values.createdAt as unknown as Date).toISOString()).toBe(iso);
    expect(values.unrelated).toBe(value);
    expect(postgres.productPhotos.createdAt.mapToDriverValue(values.createdAt as unknown as Date)).toBe(iso);
  });
  it("accepts native Date, preserves null/omitted fields and does not mutate inputs", () => {
    const date = new Date(iso); const values = { createdAt: date, appliedAt: null, unrelated: date };
    const mapped = photoTimestampValues(values, intakeTimestampFields, true);
    expect(mapped.createdAt).toBe(date); expect(mapped.appliedAt).toBeNull(); expect(mapped).not.toHaveProperty("updatedAt");
    const record = photoTimestampRecord(mapped, intakeTimestampFields);
    expect(record.createdAt).toBe(iso); expect(record.unrelated).toBe(date); expect(values.createdAt).toBe(date);
  });
  it.each(["invalid", "2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", new Date(NaN), 0, {}])("rejects invalid/ambiguous Date-mode input: %s", createdAt => {
    expect(() => photoTimestampValues({ createdAt }, photoTimestampFields, true)).toThrow("INVALID_PHOTO_TIMESTAMP:createdAt");
  });
  it("leaves SQLite text bytes unchanged", () => {
    const values = { createdAt: "2025-12-31T19:00:00.123-05:00", updatedAt: iso };
    expect(sqlite.productPhotos.createdAt.dataType).toBe("string");
    expect(photoTimestampValues(values, photoTimestampFields, false)).toBe(values);
  });
  it("covers photo outbox timestamps without touching payload or idempotency key", () => {
    const values = Object.fromEntries(photoOutboxTimestampFields.map(field => [field, iso]));
    const result = photoTimestampValues({ ...values, payload: iso, idempotencyKey: iso }, photoOutboxTimestampFields, true);
    for (const field of photoOutboxTimestampFields) expect((result[field] as unknown as Date).toISOString()).toBe(iso);
    expect(result.payload).toBe(iso); expect(result.idempotencyKey).toBe(iso);
  });
});
for (const driver of ["sqlite", "postgres"] as const) describe.skipIf(driver === "postgres" && !postgresTestConfigured)(driver + " real photo timestamp repositories", () => {
  it("round trips intake creation, cancellation and AI photo timestamp contracts", async () => {
    const h = driver === "postgres" ? await createPostgresTestDb() : null;
    const db: any = h?.db ?? createTestDb(); const schema = driver === "postgres" ? postgres : sqlite;
    const input = { id: "intake", createdByAdminUserId: "synthetic-admin", createdAt: iso, updatedAt: iso };
    try {
      const repo = createDrizzleAiProductIntakeRepository(db, schema);
      expect(await repo.create(input)).toMatchObject({ createdAt: iso, updatedAt: iso });
      expect(await repo.findById("intake")).toMatchObject({ createdAt: iso });
      expect((await repo.list({ page: 1, pageSize: 10 }))[0].createdAt).toBe(iso);
      const photos = createDrizzleAiIntakePhotoRepository(db, schema);
      const photoInput = { id: "private", intakeId: "intake", storageKey: "private.webp", originalFilename: "synthetic.png", createdByAdminUserId: "synthetic-admin", createdAt: iso, updatedAt: iso };
      expect((await photos.createLockedIfIntakeOpen(photoInput)).row).toMatchObject({ createdAt: iso, updatedAt: iso });
      expect((await photos.listByIntake("intake"))[0].createdAt).toBe(iso);
      expect((await photos.findByIdAndIntake("intake", "private"))?.updatedAt).toBe(iso);
      await repo.create({ ...input, id: "cancel" });
      expect((await repo.cancelWithExpectedState({ id: "cancel", expectedStatus: "open", cancelledAt: iso, cancelledByAdminUserId: "synthetic-admin", updatedAt: iso })).row).toMatchObject({ cancelledAt: iso, updatedAt: iso });
      const time = driver === "postgres" ? new Date(iso) : iso;
      await db.insert(schema.products).values({ id: "product", sku: "SYNTHETIC", slug: "synthetic", title: "Synthetic", type: "unique_item", status: "draft", createdAt: time, updatedAt: time });
      const execution = driver === "postgres" ? "asynchronous" : "synchronous";
      const apply = { id: "intake", resultProductId: "product", appliedAt: iso, appliedByAdminUserId: "synthetic-admin", updatedAt: iso };
      expect((await applyIntakeWithExpectedStateInTransaction(db, schema, execution, apply)).row).toMatchObject({ appliedAt: iso, updatedAt: iso });
      expect((await applyIntakeWithExpectedStateInTransaction(db, schema, execution, apply)).updated).toBe(false);
      const finalize = { id: "intake", finalizedAt: iso, finalizedByAdminUserId: "synthetic-admin", updatedAt: iso };
      expect((await finalizeIntakeWithExpectedStateInTransaction(db, schema, execution, finalize)).row).toMatchObject({ finalizedAt: iso, updatedAt: iso });
      expect((await finalizeIntakeWithExpectedStateInTransaction(db, schema, execution, finalize)).updated).toBe(false);
      const write = (tx: any, id: string) => createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, {
        values: { id, productId: "product", url: "/photo.webp", thumbnailUrl: "/thumb.webp", filename: "photo.webp", mimeType: "image/webp", sizeBytes: 72, width: 32, height: 24, isPrimary: true, processingUpdatedAt: iso, createdAt: iso, updatedAt: iso },
        outboxEvent: { id, aggregateType: "ProductPhoto", aggregateId: id, eventType: "product_photo.promote_requested", idempotencyKey: "promote:" + id, payload: JSON.stringify({ photoId: id, productId: "product" }), status: "Pending", availableAt: iso, createdAt: iso, updatedAt: iso },
      });
      // Keep SQLite transaction callbacks fully synchronous; await only the outer PG transaction.
      const transaction = (work: (tx: any) => any) => db.transaction(work);
      await transaction((tx: any) => write(tx, "canonical"));
      const [photo] = await db.select().from(schema.productPhotos);
      const [event] = await db.select().from(schema.outboxEvents);
      expect(photoTimestampRecord(photo, photoTimestampFields)).toMatchObject({ createdAt: iso, updatedAt: iso, processingUpdatedAt: iso });
      expect(photoTimestampRecord(event, photoOutboxTimestampFields)).toMatchObject({ createdAt: iso, updatedAt: iso, availableAt: iso, idempotencyKey: "promote:canonical" });
      if (driver === "postgres") {
        await expect(transaction(async (tx: any) => { await write(tx, "rolled-back"); throw Error("synthetic rollback"); })).rejects.toThrow("synthetic rollback");
      } else {
        expect(() => transaction((tx: any) => { write(tx, "rolled-back"); throw Error("synthetic rollback"); })).toThrow("synthetic rollback");
      }
      expect(await db.select().from(schema.productPhotos).where(eq(schema.productPhotos.id, "rolled-back"))).toHaveLength(0);
      expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, "rolled-back"))).toHaveLength(0);
      if (driver === "postgres") {
        await repo.create({ ...input, id: "native", createdAt: new Date(iso) as any, updatedAt: new Date(iso) as any });
        await expect(repo.create({ ...input, id: "bad", createdAt: "invalid" })).rejects.toThrow("INVALID_PHOTO_TIMESTAMP");
        expect(await repo.findById("bad")).toBeNull();
      }
    } finally { if (h) await h.close(); else db.$client.close(); }
  });
});
