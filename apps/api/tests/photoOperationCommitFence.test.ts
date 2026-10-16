import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import {
  commitPostgresPhotoOperationFenced, commitSqlitePhotoOperationFenced,
  type PhotoCommitFenceProof,
} from "../src/services/photoOperationCommitFence";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const proof: PhotoCommitFenceProof = {
  operationId: "op-test-1", generation: 1, owner: "worker-one",
  nonce: "nonce-one", sealId: "seal-one", photoId: "photo-one",
  eventId: "event-one",
};

function seedSQLite(db: Database.Database) {
  const now = Date.now();
  db.prepare(`INSERT INTO photo_operations
    (id,kind,subject_type,subject_id,target_photo_id,main_key,thumb_key,
     input_sha256,generation,owner,nonce,state,lease_until_ms,seal_id,created_ms,updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(proof.operationId, "product_upload", "w2_request", "token-test-1",
      proof.photoId, "main-test.webp", "thumb-test.webp", "a".repeat(64),
      1, proof.owner, proof.nonce, "sealed", now + 60000, proof.sealId, now, now);
  db.prepare(`INSERT INTO photo_operation_generations
    (operation_id,generation,owner,nonce,state,created_ms,updated_ms)
    VALUES (?,?,?,?,?,?,?)`).run(proof.operationId, 1, proof.owner, proof.nonce, "active", now, now);
}

it("SQLite owner generation commit succeeds once and stale nonce fails with rollback", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    seedSQLite(db);
    expect(() => db.transaction(() => commitSqlitePhotoOperationFenced(db, { ...proof, nonce: "stale" }))()).toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect(db.prepare("SELECT state FROM photo_operations WHERE id = ?").get(proof.operationId)).toEqual({state:"sealed"});
    db.transaction(() => commitSqlitePhotoOperationFenced(db, proof))();
    expect(db.prepare("SELECT state,committed_photo_id,committed_event_id FROM photo_operations WHERE id=?").get(proof.operationId))
      .toEqual({state:"committed",committed_photo_id:proof.photoId,committed_event_id:proof.eventId});
    expect(db.prepare("SELECT state FROM photo_operation_generations WHERE operation_id=?").get(proof.operationId))
      .toEqual({state:"committed"});
    expect(() => db.transaction(() => commitSqlitePhotoOperationFenced(db, proof))()).toThrow("PHOTO_OPERATION_FENCE_LOST");
  } finally { db.close(); }
});

it("SQLite incorrect generation-history state rolls back the operation CAS", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON"); ensureSchema(db); seedSQLite(db);
    db.prepare("UPDATE photo_operation_generations SET state='superseded' WHERE operation_id=?").run(proof.operationId);
    expect(() => db.transaction(() => commitSqlitePhotoOperationFenced(db, proof))()).toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect(db.prepare("SELECT state FROM photo_operations WHERE id=?").get(proof.operationId)).toEqual({state:"sealed"});
  } finally { db.close(); }
});

it.skipIf(!postgresTestConfigured)("PostgreSQL owner CAS and history commit share caller transaction", async () => {
  const harness = await createPostgresTestDb("0040_photo_operation_ownership.sql");
  const c = await harness.pool.connect();
  try {
    const now = Date.now();
    await c.query(`INSERT INTO photo_operations
      (id,kind,subject_type,subject_id,target_photo_id,main_key,thumb_key,input_sha256,
       generation,owner,nonce,state,lease_until_ms,seal_id,created_ms,updated_ms)
      VALUES ($1,'product_upload','w2_request','token-test-1',$2,'main-test.webp','thumb-test.webp',
       $3,1,$4,$5,'sealed',$6,$7,$8,$8)`,
      [proof.operationId,proof.photoId,"a".repeat(64),proof.owner,proof.nonce,now+60000,proof.sealId,now]);
    await c.query(`INSERT INTO photo_operation_generations
      (operation_id,generation,owner,nonce,state,created_ms,updated_ms)
      VALUES ($1,1,$2,$3,'active',$4,$4)`,[proof.operationId,proof.owner,proof.nonce,now]);
    await c.query("BEGIN");
    await expect(commitPostgresPhotoOperationFenced(c,{...proof,nonce:"stale"})).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await commitPostgresPhotoOperationFenced(c,proof);
    await c.query("COMMIT");
    const row=(await c.query("SELECT state,committed_photo_id FROM photo_operations WHERE id=$1",[proof.operationId])).rows[0];
    expect(row).toMatchObject({state:"committed",committed_photo_id:proof.photoId});
    await c.query("BEGIN");
    await expect(commitPostgresPhotoOperationFenced(c,proof)).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    await c.query("ROLLBACK");
  } finally { c.release(); await harness.close(); }
},120_000);
