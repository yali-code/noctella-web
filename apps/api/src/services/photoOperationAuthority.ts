import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { productPhotoStaticRoot } from "./photoStorage";
import { ownedPhotoArtifactProof } from "./ownedPhotoArtifactProof";
import { classifyExistingCanonical, type SealedGeneration } from "./photoPublicationRecoveryPolicy";

/**
 * FAZ A / #424: the shared generation-fenced photo-operation authority used by the W2 product upload owner and the
 * W4 AI-intake finalization owner (only when PHOTO_OWNERSHIP_FENCING_ENABLED=true), over the 0040 tables.
 *
 * - Operations: one row per durable subject with immutable target photo id, deterministic canonical keys and input
 *   SHA-256; generation/owner/nonce/lease decide who may seal and commit. Database time drives every lease.
 * - Claim: create generation 1, or (existing) committed / review / in progress (live lease) / reclaim after expiry
 *   (generation + 1, superseded history). Commit is the caller's same-transaction CAS (photoOperationCommitFence).
 * - Files: exclusive generation-private directories outside the public root; sealed hashes + inode identity;
 *   publication with link() only (never replace) and post-link verification; anything unexpected -> review.
 * Nothing here deletes canonical bytes.
 */
export const PHOTO_OPERATION_LEASE_MS = 5 * 60_000;
export type OwnershipDriver = "sqlite" | "postgres";
export type Rows = Array<Record<string, any>>;
export interface OwnedOperation { id: string; generation: number; owner: string; nonce: string; photoId: string; mainKey: string; thumbKey: string }
export type OperationClaim = { kind: "owned"; op: OwnedOperation } | { kind: "committed"; photoId: string } | { kind: "conflict" | "in-progress" | "review" };
export interface OperationSubject { kind: "product_upload" | "ai_finalize"; subjectType: string; subjectId: string; targetPhotoId: string; mainKey: string; thumbKey: string; inputSha256: string }
export type FileProof = { sha256: string; bytes: number; dev: string; ino: string };

/**
 * SQL dialect of the ownership tables for the configured runtime driver (db/config.ts): both PostgreSQL drivers
 * ("postgres", "supabase-postgres") are asynchronous PostgreSQL; "sqlite" (and the SQLite-backed "test-memory"
 * test driver, NODE_ENV=test only) is synchronous SQLite. Anything else is refused instead of guessing SQLite (#458).
 */
export function ownershipDriver(env: NodeJS.ProcessEnv = process.env): OwnershipDriver {
  const driver = env.DATABASE_DRIVER ?? "sqlite";
  if (driver === "postgres" || driver === "supabase-postgres") return "postgres";
  if (driver === "sqlite" || (driver === "test-memory" && env.NODE_ENV === "test")) return "sqlite";
  throw new Error(`UNSUPPORTED_PHOTO_OWNERSHIP_DRIVER:${driver}`);
}
export const nowMs = (driver: OwnershipDriver): SQL => sql.raw(driver === "sqlite" ? "CAST(unixepoch('subsec') * 1000 AS INTEGER)" : "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint");
export const uniqueViolation = (error: any) => error?.code === "23505" || /UNIQUE constraint failed|SQLITE_CONSTRAINT/.test(String(error?.message ?? error?.code ?? ""));
const rowLock = (driver: OwnershipDriver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");

/** Runs generator-expressed SQL steps in one transaction: synchronously on SQLite (never a Promise), awaited on PostgreSQL. */
export function inOwnershipTransaction<T>(db: DbClient, driver: OwnershipDriver, steps: () => Generator<SQL, T, Rows>): T | Promise<T> {
  if (driver === "sqlite") {
    let result!: T;
    const run = (db as any).transaction((tx: any) => {
      const gen = steps();
      let step = gen.next();
      while (!step.done) step = gen.next(tx.all(step.value) as Rows);
      result = step.value;
    }, { behavior: "immediate" });
    if (typeof run === "function") run();
    else if (typeof run?.then === "function") {
      // An asynchronous (PostgreSQL) client on the synchronous path: fail loudly, never return an unset result or
      // leave its rejection unhandled (#458).
      run.then(undefined, () => undefined);
      throw new Error("PHOTO_OWNERSHIP_DRIVER_MISMATCH: asynchronous database client on the SQLite ownership path");
    }
    return result;
  }
  return (db as any).transaction(async (tx: any) => {
    const gen = steps();
    let step = gen.next();
    while (!step.done) step = gen.next(((await tx.execute(step.value)) as { rows: Rows }).rows);
    return step.value;
  });
}

/** Classifies (and if expired, reclaims) an existing operation inside the caller's claim transaction. */
export function* claimExistingOperation(driver: OwnershipDriver, operationId: string, ttl: number): Generator<SQL, OperationClaim, Rows> {
  const now = nowMs(driver);
  const [op] = yield sql`SELECT id, generation, state, target_photo_id, main_key, thumb_key, committed_photo_id, CASE WHEN lease_until_ms <= ${now} THEN 1 ELSE 0 END AS expired FROM photo_operations WHERE id = ${operationId}${rowLock(driver)}`;
  if (!op) return { kind: "review" };
  if (op.state === "committed") return { kind: "committed", photoId: op.committed_photo_id };
  if (op.state === "review") return { kind: "review" };
  if (Number(op.expired) !== 1) return { kind: "in-progress" };
  const generation = Number(op.generation), next = generation + 1, owner = randomUUID(), nonce = randomUUID();
  const reclaimed = yield sql`UPDATE photo_operations SET generation = ${next}, owner = ${owner}, nonce = ${nonce}, state = 'preparing', seal_id = NULL, lease_until_ms = ${now} + ${ttl}, updated_ms = ${now}
    WHERE id = ${op.id} AND generation = ${generation} AND state IN ('preparing', 'sealed') AND lease_until_ms <= ${now} RETURNING id`;
  if (reclaimed.length !== 1) return { kind: "in-progress" };
  yield sql`UPDATE photo_operation_generations SET state = 'superseded', updated_ms = ${now} WHERE operation_id = ${op.id} AND generation = ${generation} AND state = 'active' RETURNING operation_id`;
  yield sql`INSERT INTO photo_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${op.id}, ${next}, ${owner}, ${nonce}, 'active', ${now}, ${now}) RETURNING operation_id`;
  return { kind: "owned", op: { id: op.id, generation: next, owner, nonce, photoId: op.target_photo_id, mainKey: op.main_key, thumbKey: op.thumb_key } };
}

/** Creates generation 1 of a new operation inside the caller's claim transaction. */
export function* createOperation(driver: OwnershipDriver, subject: OperationSubject, ttl: number): Generator<SQL, OwnedOperation, Rows> {
  const now = nowMs(driver);
  const id = randomUUID(), owner = randomUUID(), nonce = randomUUID();
  yield sql`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
    VALUES (${id}, ${subject.kind}, ${subject.subjectType}, ${subject.subjectId}, ${subject.targetPhotoId}, ${subject.mainKey}, ${subject.thumbKey}, ${subject.inputSha256}, 1, ${owner}, ${nonce}, 'preparing', ${now} + ${ttl}, ${now}, ${now}) RETURNING id`;
  yield sql`INSERT INTO photo_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${id}, 1, ${owner}, ${nonce}, 'active', ${now}, ${now}) RETURNING operation_id`;
  return { id, generation: 1, owner, nonce, photoId: subject.targetPhotoId, mainKey: subject.mainKey, thumbKey: subject.thumbKey };
}

/** Row lock of an operation found by its durable subject (W4: one staged photo). */
export function* findOperationBySubject(driver: OwnershipDriver, subjectType: string, subjectId: string): Generator<SQL, Record<string, any> | undefined, Rows> {
  const [row] = yield sql`SELECT id, kind, target_photo_id, main_key, thumb_key, input_sha256 FROM photo_operations WHERE subject_type = ${subjectType} AND subject_id = ${subjectId}${rowLock(driver)}`;
  return row;
}

export async function fileProof(file: string): Promise<FileProof> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("PHOTO_ARTIFACT_NOT_REGULAR");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: info.size, dev: String(info.dev), ino: String(info.ino) };
}

/** Stores a generation's sealed artifacts and moves preparing -> sealed only while this generation holds the lease. */
export function* sealSteps(driver: OwnershipDriver, op: OwnedOperation, sealId: string, main: FileProof, thumb: FileProof): Generator<SQL, boolean, Rows> {
  const now = nowMs(driver);
  const sealed = yield sql`UPDATE photo_operations SET state = 'sealed', seal_id = ${sealId}, updated_ms = ${now}
    WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner} AND nonce = ${op.nonce} AND state = 'preparing' AND lease_until_ms > ${now} RETURNING id`;
  if (sealed.length !== 1) return false;
  yield sql`INSERT INTO photo_operation_artifacts (id, operation_id, generation, relative_path, main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino, created_ms)
    VALUES (${sealId}, ${op.id}, ${op.generation}, ${`${op.id}/${op.generation}`}, ${main.sha256}, ${thumb.sha256}, ${main.bytes}, ${thumb.bytes}, ${main.dev}, ${main.ino}, ${thumb.dev}, ${thumb.ino}, ${now}) RETURNING id`;
  return true;
}

export function* reviewSteps(driver: OwnershipDriver, op: OwnedOperation, reason: string): Generator<SQL, void, Rows> {
  yield sql`UPDATE photo_operations SET state = 'review', review_reason = ${reason}, updated_ms = ${nowMs(driver)} WHERE id = ${op.id} AND generation = ${op.generation} AND nonce = ${op.nonce} AND state IN ('preparing', 'sealed') RETURNING id`;
}

export const photoOperationPrivateRoot = (canonicalRoot = productPhotoStaticRoot) => path.join(path.dirname(path.resolve(canonicalRoot)), ".product-photo-operations");

/** Exclusive generation-private directory (an existing generation directory is never reused). */
export async function createGenerationDirectory(op: OwnedOperation, canonicalRoot = productPhotoStaticRoot): Promise<string> {
  const operationDir = path.join(photoOperationPrivateRoot(canonicalRoot), op.id);
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const generationDir = path.join(operationDir, String(op.generation));
  await mkdir(generationDir, { mode: 0o700 });
  return generationDir;
}

/** Seals prepared files under the fence; false (nothing published) if this generation lost ownership. */
export async function sealPreparedArtifacts(db: DbClient, driver: OwnershipDriver, op: OwnedOperation, files: { main: string; thumb: string }) {
  const sealId = randomUUID();
  const main = await ownedPhotoArtifactProof(files.main), thumb = await ownedPhotoArtifactProof(files.thumb);
  const sealed = await inOwnershipTransaction(db, driver, () => sealSteps(driver, op, sealId, main, thumb));
  return sealed ? { sealId, main, thumb } : null;
}

/** Reads only this operation's durable seals; a live private inode prevents inode-number reuse. */
async function ownSealedGenerations(db: DbClient, driver: OwnershipDriver, op: OwnedOperation, artifact: "main" | "thumb", currentFile: string, canonicalRoot: string): Promise<SealedGeneration[]> {
  const rows = await inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
    return yield sql`SELECT generation, main_sha256, thumb_sha256, main_dev, main_ino, thumb_dev, thumb_ino FROM photo_operation_artifacts WHERE operation_id = ${op.id}`;
  });
  const generations: SealedGeneration[] = [];
  for (const row of rows) {
    const generation = Number(row.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("PHOTO_ARTIFACT_GENERATION_INVALID");
    const seal = { sha256: String(row[artifact + "_sha256"]), dev: String(row[artifact + "_dev"]), ino: String(row[artifact + "_ino"]) };
    let live: FileProof | null = null;
    try { live = await ownedPhotoArtifactProof(generation === op.generation ? currentFile : path.join(photoOperationPrivateRoot(canonicalRoot), op.id, String(generation), artifact + ".webp")); }
    catch (error: any) {
      // These proofs establish that the private name cannot authenticate a live sealed regular inode.
      // Resource/DB/unknown failures remain errors; they must not become permanent provenance decisions.
      const notLive = error?.code === "ENOENT" || error?.code === "ELOOP" ||
        (error instanceof Error && (error.message === "PHOTO_ARTIFACT_NOT_REGULAR" || error.message === "PHOTO_ARTIFACT_CHANGED"));
      if (!notLive) throw error;
    }
    generations.push({ seal, live: live?.sha256 === seal.sha256 ? live : null });
  }
  return generations;
}

/**
 * Re-verifies the sealed private files, then publishes them with link() to the operation's canonical keys. The
 * published name must afterwards be exactly the sealed inode, or an authenticated still-live sealed inode
 * of this operation with the current sealed bytes. Anything else moves the operation to review; nothing is replaced.
 */
export async function publishSealedArtifacts(db: DbClient, driver: OwnershipDriver, op: OwnedOperation, files: { main: string; thumb: string }, seal: { main: FileProof; thumb: FileProof }, canonicalRoot = productPhotoStaticRoot) {
  // Main and thumb may come from different authenticated generations after a partial crash. Each must
  // independently match this operation's live recorded inode AND the current artifact's sealed bytes;
  // this proves per-artifact provenance, not a single-generation pair or publication authority (F2).
  for (const [artifact, file, proof, key] of [["main", files.main, seal.main, op.mainKey], ["thumb", files.thumb, seal.thumb, op.thumbKey]] as const) {
    const current = await ownedPhotoArtifactProof(file);
    if (current.sha256 !== proof.sha256 || current.ino !== proof.ino || current.dev !== proof.dev) {
      await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, "sealed artifact changed before publication"));
      throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Sealed photo artifact changed before publication");
    }
    const destination = path.join(canonicalRoot, key);
    await mkdir(canonicalRoot, { recursive: true });
    let linked = false;
    try { await link(file, destination); linked = true; }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const published = await ownedPhotoArtifactProof(destination);
    const decision = linked ? null : classifyExistingCanonical(published, proof, await ownSealedGenerations(db, driver, op, artifact, file, canonicalRoot));
    if (published.sha256 !== proof.sha256 || (linked ? (published.ino !== proof.ino || published.dev !== proof.dev) : decision !== "ADOPT_OWN_GENERATION")) {
      // A committed successor may have removed its private names. Never re-adopt or mutate on its behalf.
      const [latest] = await inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
        return yield sql`SELECT generation, state FROM photo_operations WHERE id = ${op.id}`;
      });
      if (latest?.state === "committed" && Number(latest.generation) !== op.generation)
        throw new PhotoUploadError(503, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before publication");
      await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, linked ? "published inode differs from the seal" : String(decision)));
      throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Canonical photo key does not match the sealed artifact");
    }
  }
}

/** Read-only recovery report: every non-committed operation whose lease expired, plus every review item. Never deletes. */
export function listPhotoOperationsRequiringRecovery(db: DbClient, driver: OwnershipDriver = ownershipDriver()) {
  return inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
    const now = nowMs(driver);
    return yield sql`SELECT id, kind, subject_type, subject_id AS token, generation, state, main_key, thumb_key, seal_id, review_reason FROM photo_operations
      WHERE state = 'review' OR (state IN ('preparing', 'sealed') AND lease_until_ms <= ${now}) ORDER BY created_ms`;
  });
}
