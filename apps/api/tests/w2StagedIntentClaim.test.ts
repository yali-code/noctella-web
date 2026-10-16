import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { claimSqliteW2UploadIntent, claimPostgresW2UploadIntent } from "../src/services/w2OperationIdentity";
import { claimW2StagedInputIdentity } from "../src/services/w2StagedIntentClaim";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const scope = {
  tenantId: "trusted-tenant", actorId: "trusted-actor",
  productId: "trusted-product", token: "verified_token_00001", altText: "Front",
};
async function staging(bytes: Buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "noctella-w2-claim-"));
  const file = path.join(dir, "input");
  await writeFile(file, bytes);
  return { dir, input: {
    path: file, workDir: dir, size: bytes.length,
    signal: new AbortController().signal, mimetype: "image/jpeg",
  }};
}

it("claims real private staged bytes into SQLite immutable identity, without publishing photos", async () => {
  const db = new Database(":memory:");
  const { dir, input } = await staging(Buffer.from("image-first"));
  try {
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    const claim = (identity: Parameters<typeof claimSqliteW2UploadIntent>[1], ms: number) =>
      claimSqliteW2UploadIntent(db, identity, ms);
    expect(await claimW2StagedInputIdentity(input, scope, claim, 100, 1000)).toBe("NEW");
    expect(await claimW2StagedInputIdentity(input, scope, claim, 101, 1000)).toBe("SAME_INTENT");
    await writeFile(input.path, "image-other");
    const changed = { ...input, size: Buffer.byteLength("image-other") };
    expect(await claimW2StagedInputIdentity(changed, scope, claim, 102, 1000)).toBe("CONFLICT");
    expect(db.prepare("SELECT input_sha256, created_ms FROM photo_w2_upload_intents WHERE token = ?").get(scope.token))
      .toEqual({ input_sha256: createHash("sha256").update("image-first").digest("hex"), created_ms: 100 });
    for (const table of ["photo_operations", "product_photos", "outbox_events"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

it("rejects invalid trusted scope before reading any private staged input or claiming a token", async () => {
  let claims = 0;
  const mockClaim = () => { claims++; return "NEW" as const; };
  const abort = new AbortController();
  const missing = { path: "/not-created/input", workDir: "/not-created", size: 1,
    signal: abort.signal, mimetype: "image/jpeg" };
  expect(await claimW2StagedInputIdentity(missing, { ...scope, token: "bad" }, mockClaim, 100, 1000)).toBe("INVALID");
  expect(await claimW2StagedInputIdentity(missing, scope, mockClaim, -1, 1000)).toBe("INVALID");
  expect(claims).toBe(0);
});

it.skipIf(!postgresTestConfigured)("claims real private staged digest into PostgreSQL without canonical side effects", async () => {
  const testDb = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
  const { dir, input } = await staging(Buffer.from("postgres-image"));
  try {
    const claim = (identity: Parameters<typeof claimPostgresW2UploadIntent>[1], ms: number) =>
      claimPostgresW2UploadIntent(testDb.pool, identity, ms);
    expect(await claimW2StagedInputIdentity(input, scope, claim, 100, 1000)).toBe("NEW");
    expect(await claimW2StagedInputIdentity(input, scope, claim, 200, 1000)).toBe("SAME_INTENT");
    expect(await claimW2StagedInputIdentity(input, { ...scope, actorId: "other-actor" }, claim, 300, 1000)).toBe("CONFLICT");
    const rows = await testDb.pool.query("SELECT COUNT(*) AS n FROM photo_w2_upload_intents");
    expect(rows.rows[0].n).toBe("1");
    for (const table of ["photo_operations", "product_photos", "outbox_events"])
      expect((await testDb.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n).toBe("0");
  } finally { await testDb.close(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);
