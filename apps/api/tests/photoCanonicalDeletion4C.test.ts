/**
 * 4C (#424): authorized canonical deletion (photoCanonicalDeletion.ts) on SQLite and PostgreSQL. Synthetic committed
 * operation/intent/copy rows bind real files in a disposable canonical root; the canonical identity is the file's own
 * (legacy numeric device) inode, as the copy publisher records it. Every retention case keeps both files and all rows.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { inOwnershipTransaction, type OwnershipDriver } from "../src/services/photoOperationAuthority";
import { authorizedCanonicalDeletionSteps, deleteAuthorizedCanonicalPhoto } from "../src/services/photoCanonicalDeletion";
import { createProductPhotoOutboxDispatcher } from "../src/services/productPhotoOutboxDispatcher";
import { SqliteOutboxRepository } from "../src/services/outboxRepository";
import { OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-4c-delete-"));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

interface Harness { db: any; q: (s: SQL) => Promise<any[]>; close: () => Promise<void> }

async function sqliteHarness(): Promise<Harness> {
  const raw = new Database(path.join(tmpRoot, `${randomUUID()}.sqlite`));
  raw.pragma("foreign_keys = ON");
  ensureSchema(raw);
  const db = drizzle(raw, { schema });
  return { db, q: async (s) => db.all(s), close: async () => { raw.close(); } };
}
async function postgresHarness(): Promise<Harness> {
  const h = await createPostgresTestDb("0044_photo_publication_copies.sql");
  return { db: h.db, q: async (s) => (await h.db.execute(s)).rows as any[], close: () => h.close() };
}

it("PostgreSQL retains before any database or file access (no PostgreSQL instance needed)", async () => {
  const db = new Proxy({}, { get: () => { throw new Error("database touched"); } });
  expect(await deleteAuthorizedCanonicalPhoto(db as never, "postgres", path.join(tmpRoot, "missing-root"), "any-photo")).toEqual({ kind: "retained", code: "PHOTO_DELETE_REFERENCES_UNSERIALIZED" });
});

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("4C authorized W8 deletion on %s", (driver: OwnershipDriver, configured) => {
  let h: Harness, root: string;
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!configured)(name, fn, 60_000);
  beforeAll(async () => { if (configured) h = driver === "sqlite" ? await sqliteHarness() : await postgresHarness(); });
  afterAll(async () => { await h?.close(); });
  beforeEach(() => { root = fs.mkdtempSync(path.join(tmpRoot, "canonical-")); });
  // The locked steps on both drivers; the public entry point (asserted below) only enables them on SQLite.
  const del = (photoId: string) => Promise.resolve().then(() => inOwnershipTransaction(h.db, driver, () => authorizedCanonicalDeletionSteps(driver, root, photoId)));

  run("the public entry point deletes on SQLite and retains on PostgreSQL (unserialized order snapshots)", async () => {
    const s = await seed();
    const out = await deleteAuthorizedCanonicalPhoto(h.db, driver, root, s.photoId);
    if (driver === "sqlite") { expect(out).toEqual({ kind: "deleted", removed: 2 }); expect(present(s)).toEqual([false, false]); }
    else { expect(out).toEqual({ kind: "retained", code: "PHOTO_DELETE_REFERENCES_UNSERIALIZED" }); expect(present(s)).toEqual([true, true]); }
  });

  async function seed(o: { opState?: string; intentState?: string; copies?: boolean } = {}) {
    const photoId = randomUUID(), opId = randomUUID(), sealId = randomUUID();
    const mainKey = `p1-${photoId}.webp`, thumbKey = `p1-${photoId}-thumb.webp`;
    const proof = (key: string, body: string) => {
      const file = path.join(root, key); fs.writeFileSync(file, body);
      const st = fs.statSync(file, { bigint: true });
      return { file, sha: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body), dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs) };
    };
    const main = proof(mainKey, `main-${photoId}`), thumb = proof(thumbKey, `thumb-${photoId}`);
    const opState = o.opState ?? "committed";
    await h.q(sql`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, committed_photo_id, created_ms, updated_ms)
      VALUES (${opId}, 'product_upload', 'w2_request', ${randomUUID()}, ${photoId}, ${mainKey}, ${thumbKey}, ${"c".repeat(64)}, 1, 'owner', 'nonce', ${opState}, 0, ${opState === "committed" ? photoId : null}, 1, 1) RETURNING id`);
    await h.q(sql`INSERT INTO photo_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${opId}, 1, 'owner', 'nonce', 'committed', 1, 1) RETURNING operation_id`);
    await h.q(sql`INSERT INTO photo_operation_artifacts (id, operation_id, generation, relative_path, main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino, created_ms)
      VALUES (${sealId}, ${opId}, 1, ${`${opId}/1`}, ${main.sha}, ${thumb.sha}, ${main.bytes}, ${thumb.bytes}, ${main.dev}, '1', ${thumb.dev}, '2', 1) RETURNING id`);
    await h.q(sql`UPDATE photo_operations SET seal_id = ${sealId} WHERE id = ${opId} RETURNING id`);
    if (o.intentState !== "none") {
      await h.q(sql`INSERT INTO photo_publication_intents (operation_id, generation, owner, nonce, seal_id, main_key, thumb_key, main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino, executor_epoch, executor_token, executor_identity, state, created_ms, updated_ms)
        VALUES (${opId}, 1, 'owner', 'nonce', ${sealId}, ${mainKey}, ${thumbKey}, ${main.sha}, ${main.dev}, '1', ${thumb.sha}, ${thumb.dev}, '2', 1, ${randomUUID()}, 'executor-x', ${o.intentState ?? "committed"}, 1, 1) RETURNING operation_id`);
      if (o.copies !== false) for (const [artifact, p] of [["main", main], ["thumb", thumb]] as const) {
        await h.q(sql`INSERT INTO photo_publication_copies (operation_id, artifact, executor_epoch, staging_name, copy_dev, copy_ino, copy_birth_ns, sha256, bytes, recorded_ms)
          VALUES (${opId}, ${artifact}, 1, 'data-0000000000000000', ${p.dev}, ${p.ino}, ${p.birth}, ${p.sha}, ${p.bytes}, 1) RETURNING operation_id`);
      }
    }
    return { photoId, opId, mainKey, thumbKey, main, thumb };
  }
  const evidence = async (opId: string) => [
    await h.q(sql`SELECT id, state, committed_photo_id FROM photo_operations WHERE id = ${opId}`),
    await h.q(sql`SELECT state FROM photo_publication_intents WHERE operation_id = ${opId}`),
    await h.q(sql`SELECT artifact, copy_ino FROM photo_publication_copies WHERE operation_id = ${opId} ORDER BY artifact`),
  ];
  const present = (s: { main: { file: string }; thumb: { file: string } }) => [fs.existsSync(s.main.file), fs.existsSync(s.thumb.file)];

  run("deletes exactly the committed, unreferenced recorded copies; evidence rows and other files stay; replay is idempotent", async () => {
    const s = await seed();
    const unrelated = path.join(root, "unrelated.webp"); fs.writeFileSync(unrelated, "foreign");
    const before = await evidence(s.opId);
    expect(await del(s.photoId)).toEqual({ kind: "deleted", removed: 2 });
    expect(present(s)).toEqual([false, false]);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(await evidence(s.opId)).toEqual(before);
    expect(await del(s.photoId)).toEqual({ kind: "deleted", removed: 0 });
  });

  run("a partially completed earlier deletion finishes only the remaining verified name", async () => {
    const s = await seed();
    fs.unlinkSync(s.main.file);
    expect(await del(s.photoId)).toEqual({ kind: "deleted", removed: 1 });
    expect(present(s)).toEqual([false, false]);
  });

  run("unknown or unresolved ownership retains both files", async () => {
    expect(await del(randomUUID())).toEqual({ kind: "retained", code: "PHOTO_DELETE_OWNERSHIP_UNKNOWN" });
    for (const [o, code] of [
      [{ opState: "sealed" }, "PHOTO_DELETE_OPERATION_UNRESOLVED"],
      [{ opState: "review" }, "PHOTO_DELETE_OPERATION_UNRESOLVED"],
      [{ intentState: "authorized" }, "PHOTO_DELETE_OPERATION_UNRESOLVED"],
      [{ intentState: "review" }, "PHOTO_DELETE_OPERATION_UNRESOLVED"],
      [{ intentState: "none" }, "PHOTO_DELETE_OWNERSHIP_UNKNOWN"],
      [{ copies: false }, "PHOTO_DELETE_OWNERSHIP_UNKNOWN"],
    ] as const) {
      const s = await seed(o);
      expect(await del(s.photoId), JSON.stringify(o)).toEqual({ kind: "retained", code });
      expect(present(s)).toEqual([true, true]);
    }
  });

  run("a current photo row or media reference retains both files", async () => {
    const live = await seed();
    await h.q(sql`INSERT INTO products (id, sku, title, slug, type, status) VALUES (${live.photoId}, ${live.photoId}, 't', ${live.photoId}, 'Physical', 'Draft') RETURNING id`);
    await h.q(sql`INSERT INTO product_photos (id, product_id, url, thumbnail_url, filename, mime_type, size_bytes, width, height) VALUES (${live.photoId}, ${live.photoId}, ${`/images/product-photos/${live.mainKey}`}, ${`/images/product-photos/${live.thumbKey}`}, ${live.mainKey}, 'image/webp', 1, 1, 1) RETURNING id`);
    expect(await del(live.photoId)).toEqual({ kind: "retained", code: "PHOTO_DELETE_KEY_REFERENCED" });
    expect(present(live)).toEqual([true, true]);
    const category = await seed();
    await h.q(sql`INSERT INTO categories (id, name, slug, display_image_url) VALUES (${randomUUID()}, 'c', ${randomUUID()}, ${`https://shop.example/images/product-photos/${category.thumbKey}?v=1`}) RETURNING id`);
    expect(await del(category.photoId)).toEqual({ kind: "retained", code: "PHOTO_DELETE_KEY_REFERENCED" });
    expect(present(category)).toEqual([true, true]);
  });

  run("a foreign or changed file at either key retains both names", async () => {
    const replaced = await seed();
    fs.unlinkSync(replaced.thumb.file); fs.writeFileSync(replaced.thumb.file, `thumb-${replaced.photoId}`); // same bytes, new inode
    expect(await del(replaced.photoId)).toEqual({ kind: "retained", code: "PHOTO_DELETE_FOREIGN_FILE" });
    expect(present(replaced)).toEqual([true, true]);
    const changed = await seed();
    fs.appendFileSync(changed.main.file, "x"); // same inode, changed bytes
    expect(await del(changed.photoId)).toEqual({ kind: "retained", code: "PHOTO_DELETE_FOREIGN_FILE" });
    expect(present(changed)).toEqual([true, true]);
  });

  if (driver === "sqlite") run("production W8 dispatcher with fencing ON: authorized events complete; pathname-keyed events without ownership are dead-lettered and retained", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    try {
      const s = await seed();
      const legacy = path.join(root, "legacy.webp"); fs.writeFileSync(legacy, "legacy");
      const outbox = new SqliteOutboxRepository((h.db as any).$client);
      const event = (id: string, photoId: string, extra: object = {}) => outbox.create({ id, eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", aggregateId: photoId, idempotencyKey: id, payload: { photoId, productId: "p1", ...extra }, maxAttempts: 3, availableAt: "2026-01-01" } as never);
      await event("authorized", s.photoId);
      await event("legacy", "legacy-photo", { storageKey: "legacy.webp", thumbnailStorageKey: "legacy.webp" });
      const mismatched = await seed();
      await outbox.create({ id: "mismatched", eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", aggregateId: "other-photo", idempotencyKey: "mismatched", payload: { photoId: mismatched.photoId }, maxAttempts: 3, availableAt: "2026-01-01" } as never);
      await createProductPhotoOutboxDispatcher(h.db, "sqlite", { tempRoot: root, permanentRoot: root }).dispatchDueEvents("w", 5);
      expect(await outbox.getById("mismatched")).toMatchObject({ status: OutboxEventStatus.DeadLetter, lastErrorCode: "PHOTO_DELETE_OWNERSHIP_UNKNOWN" });
      expect(present(mismatched)).toEqual([true, true]);
      expect((await outbox.getById("authorized"))?.status).toBe(OutboxEventStatus.Succeeded);
      expect(present(s)).toEqual([false, false]);
      expect(await outbox.getById("legacy")).toMatchObject({ status: OutboxEventStatus.DeadLetter, lastErrorCode: "PHOTO_DELETE_OWNERSHIP_UNKNOWN" });
      expect(fs.existsSync(legacy)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  if (driver === "postgres") run("eligibility is read under the operation row lock: a concurrent state change wins", async () => {
    const s = await seed();
    const pool = (h.db as any).$client;
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT id FROM photo_operations WHERE id = $1 FOR UPDATE", [s.opId]);
      const pending = del(s.photoId);
      await new Promise((r) => setTimeout(r, 300));
      expect(present(s)).toEqual([true, true]);
      await other.query("UPDATE photo_operations SET state = 'review' WHERE id = $1", [s.opId]);
      await other.query("COMMIT");
      expect(await pending).toEqual({ kind: "retained", code: "PHOTO_DELETE_OPERATION_UNRESOLVED" });
      expect(present(s)).toEqual([true, true]);
    } finally { other.release(); }
  });
});
