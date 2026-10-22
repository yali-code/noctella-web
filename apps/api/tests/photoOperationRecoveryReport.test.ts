/**
 * FAZ A #424 package F: the operator report is read-only and reports exactly what needs attention, on SQLite and
 * (when configured) real PostgreSQL. Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { buildPhotoOperationReport } from "../src/scripts/photoOperationRecoveryReport";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const proposal = readFileSync(path.resolve(__dirname, "../../../docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal"), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("photo operation report on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {};
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (s: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows);
  const op = (state: string, lease: number, kind = "product_upload") => {
    const id = randomUUID();
    return q(sql`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, review_reason, created_ms, updated_ms)
      VALUES (${id}, ${kind}, 'w2_request', ${randomUUID()}, ${randomUUID()}, ${randomUUID() + ".webp"}, ${randomUUID() + "-thumb.webp"}, ${"a".repeat(64)}, 1, 'o', ${randomUUID()}, ${state}, ${lease}, ${state === "review" ? "test reason" : null}, 0, 0) RETURNING id`).then(() => id);
  };
  const snapshot = async () => JSON.stringify(await q(sql`SELECT id, state, lease_until_ms, updated_ms FROM photo_operations ORDER BY id`));

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const harness = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
      db = harness.db; close = () => harness.close();
    } else { delete process.env.DATABASE_DRIVER; db = createTestDb(); }
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("an empty ownership schema reports nothing to do; W11 is absent", async () => {
    const report = await buildPhotoOperationReport(db, driver);
    expect(report).toMatchObject({ readOnly: true, attentionCount: 0, derivatives: null, w2Intents: { total: 0, unbound: 0 } });
    expect(report.operations?.attention).toEqual([]);
  });

  it.skipIf(!enabled)("reports expired, sealed and review operations (not live or committed ones) and changes nothing", async () => {
    const expiredPreparing = await op("preparing", 0), expiredSealed = await op("sealed", 0), review = await op("review", 0, "ai_finalize");
    await op("preparing", Date.now() + 3_600_000); await op("committed", 0);
    const before = await snapshot();
    const report = await buildPhotoOperationReport(db, driver);
    expect(await snapshot()).toBe(before); // read-only
    expect(report.operations!.attention.map((r: any) => r.id).sort()).toEqual([expiredPreparing, expiredSealed, review].sort());
    expect(report.attentionCount).toBe(3);
    expect(report.operations!.rollbackBlockers.length).toBeGreaterThan(0);
    expect(report.operations!.byKindAndState.reduce((n: number, r: any) => n + r.n, 0)).toBe(5);
  });

  it.skipIf(!enabled)("includes W11 derivative attention only where the proposed table exists (disposable DB)", async () => {
    for (const s of proposal) { if (driver === "sqlite") db.run(sql.raw(s)); else await db.execute(sql.raw(s)); }
    await q(sql`INSERT INTO photo_derivative_operations (id, kind, derivative_key, source_key, source_fingerprint, recipe, generation, owner, nonce, state, lease_until_ms, review_reason, created_ms, updated_ms)
      VALUES (${randomUUID()}, 'instagram_derivative', ${"instagram-v1-" + randomUUID() + ".jpg"}, 's.webp', ${"b".repeat(64)}, 'instagram-v1', 1, 'o', ${randomUUID()}, 'committed', 0, 'committed derivative bytes changed', 0, 0) RETURNING id`);
    const report = await buildPhotoOperationReport(db, driver);
    expect(report.derivatives?.attention).toHaveLength(1);
    expect(report.attentionCount).toBe(4);
  });
});
