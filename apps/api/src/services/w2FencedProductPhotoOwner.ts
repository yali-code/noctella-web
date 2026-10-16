import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { PRODUCT_PHOTO_MAX_BYTES, productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { stagedProductPhotoStorage, type StagedProductPhotoInput } from "./stagedProductPhotoStorage";
import { classifyW2UploadIntent, isValidW2UploadIntent, type W2UploadIntent } from "./w2OperationIdentity";
import { getCommittedProductPhoto, persistFencedUploadedProductPhoto } from "./products";

/**
 * FAZ A / #424: the generation-fenced W2 product-photo owner (used only when PHOTO_OWNERSHIP_FENCING_ENABLED=true).
 *
 * 1. Claim, one DB transaction (SQLite IMMEDIATE / PostgreSQL): a new request token creates the photo_operations row
 *    (kind product_upload, deterministic keys from a fresh target photo id), its first generation and the immutable
 *    W2 intent bound to that operation. A known token is classified: different intent -> 409; committed -> the
 *    committed photo; live lease -> 409 in progress; review -> 409; expired lease -> reclaim with generation + 1.
 * 2. Prepare: the existing staged recipe, path-fed, into `<root>/../.product-photo-operations/<op>/<generation>/`
 *    (exclusive directory, outside the public static root).
 * 3. Seal: streamed SHA-256, size and inode identity recorded, operation preparing -> sealed under the fence.
 * 4. Publish: re-verify the sealed files, then link() to the deterministic canonical keys; an existing key is
 *    accepted only if byte-identical to the seal, otherwise the operation is moved to review (never overwritten).
 * 5. Commit: persistFencedUploadedProductPhoto - photo row, promote outbox event and the generation CAS in one
 *    transaction; a lost fence rolls everything back. Nothing here ever deletes canonical bytes.
 *
 * Database time drives every lease decision. Crashes leave the operation preparing/sealed with private evidence;
 * a retry with the same Idempotency-Key reclaims it after lease expiry (listW2OperationsRequiringRecovery reports
 * the rest read-only).
 */
export const W2_OPERATION_LEASE_MS = 5 * 60_000;
/** Noctella is single-tenant: the intent scope is fixed server-side, never client-supplied. */
const TENANT_SCOPE = "noctella";

export interface FencedUploadCommand { productId: string; actorId: string; operationToken: string; sha256: string; altText: string; file: StagedProductPhotoInput }
interface Owned { id: string; generation: number; owner: string; nonce: string; photoId: string; mainKey: string; thumbKey: string }
type Claim = { kind: "owned"; op: Owned } | { kind: "committed"; photoId: string } | { kind: "conflict" | "in-progress" | "review" };
type Driver = "sqlite" | "postgres";
type Rows = Array<Record<string, any>>;

const driverOf = (): Driver => (((process.env.DATABASE_DRIVER as string) || "sqlite") === "postgres" ? "postgres" : "sqlite");
const nowMs = (driver: Driver): SQL => sql.raw(driver === "sqlite" ? "CAST(unixepoch('subsec') * 1000 AS INTEGER)" : "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint");
const conflictCode = (error: any) => error?.code === "23505" || /UNIQUE constraint failed|SQLITE_CONSTRAINT/.test(String(error?.message ?? error?.code ?? ""));

/** Runs generator-expressed SQL steps in one transaction: synchronously on SQLite (never a Promise), awaited on PostgreSQL. */
function inTransaction<T>(db: DbClient, driver: Driver, steps: () => Generator<SQL, T, Rows>): T | Promise<T> {
  if (driver === "sqlite") {
    let result!: T;
    const run = (db as any).transaction((tx: any) => {
      const gen = steps();
      let step = gen.next();
      while (!step.done) step = gen.next(tx.all(step.value) as Rows);
      result = step.value;
    }, { behavior: "immediate" });
    if (typeof run === "function") run();
    return result;
  }
  return (db as any).transaction(async (tx: any) => {
    const gen = steps();
    let step = gen.next();
    while (!step.done) step = gen.next(((await tx.execute(step.value)) as { rows: Rows }).rows);
    return step.value;
  });
}

function* claimSteps(driver: Driver, intent: W2UploadIntent, ttl: number): Generator<SQL, Claim, Rows> {
  const now = nowMs(driver);
  const lock = sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
  const [stored] = yield sql`SELECT token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id FROM photo_w2_upload_intents WHERE token = ${intent.token}${lock}`;
  if (stored) {
    const decision = classifyW2UploadIntent({ kind: "W2_PRODUCT_PHOTO_UPLOAD", token: stored.token, tenantId: stored.tenant_id, actorId: stored.actor_id, productId: stored.product_id, sha256: stored.input_sha256, altText: stored.alt_text }, intent);
    if (decision !== "SAME_INTENT" || !stored.operation_id) return { kind: "conflict" };
    const [op] = yield sql`SELECT id, generation, state, target_photo_id, main_key, thumb_key, committed_photo_id, CASE WHEN lease_until_ms <= ${now} THEN 1 ELSE 0 END AS expired FROM photo_operations WHERE id = ${stored.operation_id}${lock}`;
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
  const id = randomUUID(), photoId = randomUUID(), owner = randomUUID(), nonce = randomUUID();
  const mainKey = `${intent.productId}-${photoId}.webp`, thumbKey = `${intent.productId}-${photoId}-thumb.webp`;
  yield sql`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
    VALUES (${id}, 'product_upload', 'w2_request', ${intent.token}, ${photoId}, ${mainKey}, ${thumbKey}, ${intent.sha256}, 1, ${owner}, ${nonce}, 'preparing', ${now} + ${ttl}, ${now}, ${now}) RETURNING id`;
  yield sql`INSERT INTO photo_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${id}, 1, ${owner}, ${nonce}, 'active', ${now}, ${now}) RETURNING operation_id`;
  yield sql`INSERT INTO photo_w2_upload_intents (token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id, created_ms)
    VALUES (${intent.token}, ${intent.tenantId}, ${intent.actorId}, ${intent.productId}, ${intent.sha256}, ${intent.altText}, ${id}, ${now}) RETURNING token`;
  return { kind: "owned", op: { id, generation: 1, owner, nonce, photoId, mainKey, thumbKey } };
}

async function fileProof(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("PHOTO_ARTIFACT_NOT_REGULAR");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: info.size, dev: String(info.dev), ino: String(info.ino) };
}

/** Stores a generation's sealed artifacts and moves preparing -> sealed only while this generation holds the lease. */
function* sealSteps(driver: Driver, op: Owned, sealId: string, main: Awaited<ReturnType<typeof fileProof>>, thumb: Awaited<ReturnType<typeof fileProof>>): Generator<SQL, boolean, Rows> {
  const now = nowMs(driver);
  const sealed = yield sql`UPDATE photo_operations SET state = 'sealed', seal_id = ${sealId}, updated_ms = ${now}
    WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner} AND nonce = ${op.nonce} AND state = 'preparing' AND lease_until_ms > ${now} RETURNING id`;
  if (sealed.length !== 1) return false;
  yield sql`INSERT INTO photo_operation_artifacts (id, operation_id, generation, relative_path, main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino, created_ms)
    VALUES (${sealId}, ${op.id}, ${op.generation}, ${`${op.id}/${op.generation}`}, ${main.sha256}, ${thumb.sha256}, ${main.bytes}, ${thumb.bytes}, ${main.dev}, ${main.ino}, ${thumb.dev}, ${thumb.ino}, ${now}) RETURNING id`;
  return true;
}

function* reviewSteps(driver: Driver, op: Owned, reason: string): Generator<SQL, void, Rows> {
  yield sql`UPDATE photo_operations SET state = 'review', review_reason = ${reason}, updated_ms = ${nowMs(driver)} WHERE id = ${op.id} AND generation = ${op.generation} AND nonce = ${op.nonce} AND state IN ('preparing', 'sealed') RETURNING id`;
}

export const w2OperationPrivateRoot = (canonicalRoot = productPhotoStaticRoot) => path.join(path.dirname(path.resolve(canonicalRoot)), ".product-photo-operations");

/** Test seams for crash/acknowledgement-loss acceptance; never set by the production router. */
export interface FencedUploadHooks { afterSeal?: () => void | Promise<void>; afterPublish?: () => void | Promise<void>; afterCommit?: () => void | Promise<void> }

export async function uploadFencedProductPhoto(db: DbClient, command: FencedUploadCommand, options: { canonicalRoot?: string; driver?: Driver; leaseMs?: number; hooks?: FencedUploadHooks } = {}) {
  const driver = options.driver ?? driverOf();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const intent: W2UploadIntent = { kind: "W2_PRODUCT_PHOTO_UPLOAD", tenantId: TENANT_SCOPE, actorId: command.actorId, productId: command.productId, token: command.operationToken, sha256: command.sha256, altText: command.altText };
  if (!isValidW2UploadIntent(intent) || command.file.size > PRODUCT_PHOTO_MAX_BYTES) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Invalid fenced photo upload");

  let claim: Claim;
  try { claim = await inTransaction(db, driver, () => claimSteps(driver, intent, options.leaseMs ?? W2_OPERATION_LEASE_MS)); }
  catch (error) {
    if (!conflictCode(error)) throw error;
    // A concurrent first claim of the same token won; classify against the now-committed intent.
    claim = await inTransaction(db, driver, () => claimSteps(driver, intent, options.leaseMs ?? W2_OPERATION_LEASE_MS));
  }
  if (claim.kind === "committed") {
    const photo = await getCommittedProductPhoto(db, command.productId, claim.photoId);
    if (!photo) throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Committed photo operation requires review");
    return photo;
  }
  if (claim.kind === "conflict") throw new PhotoUploadError(409, "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different photo upload");
  if (claim.kind === "in-progress") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo upload is already in progress");
  if (claim.kind !== "owned") throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo upload requires operator review");
  const op = claim.op;

  // Generation-private, path-fed preparation (the full original is never read into a Buffer here).
  const operationDir = path.join(w2OperationPrivateRoot(canonicalRoot), op.id);
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const generationDir = path.join(operationDir, String(op.generation));
  await mkdir(generationDir, { mode: 0o700 }); // exclusive: an existing generation directory is never reused
  let prepared: Awaited<ReturnType<typeof stagedProductPhotoStorage.prepareFencedProductPhoto>>;
  try { prepared = await stagedProductPhotoStorage.prepareFencedProductPhoto(command.file, generationDir); }
  catch (error) {
    // A deterministic input rejection (nothing sealed or published) ends this identity; retries of it are 409.
    if (error instanceof PhotoUploadError && (error.status === 400 || error.status === 413))
      await inTransaction(db, driver, () => reviewSteps(driver, op, `input rejected: ${error.code}`));
    throw error;
  }

  const sealId = randomUUID();
  const [mainProof, thumbProof] = [await fileProof(prepared.main), await fileProof(prepared.thumb)];
  if (!(await inTransaction(db, driver, () => sealSteps(driver, op, sealId, mainProof, thumbProof))))
    throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before sealing");
  await options.hooks?.afterSeal?.();

  // Verify the sealed private artifacts, then publish without ever replacing an existing canonical file.
  for (const [file, proof, key] of [[prepared.main, mainProof, op.mainKey], [prepared.thumb, thumbProof, op.thumbKey]] as const) {
    const now = await fileProof(file);
    if (now.sha256 !== proof.sha256 || now.ino !== proof.ino || now.dev !== proof.dev) {
      await inTransaction(db, driver, () => reviewSteps(driver, op, "sealed artifact changed before publication"));
      throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Sealed photo artifact changed before publication");
    }
    const destination = path.join(canonicalRoot, key);
    await mkdir(canonicalRoot, { recursive: true });
    let linked = false;
    try { await link(file, destination); linked = true; }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    // Close the verify-then-link window: the published name must now be exactly the sealed inode (this generation
    // linked it) or a pre-existing regular file with the sealed bytes (an earlier generation of this operation).
    const published = await fileProof(destination);
    if (published.sha256 !== proof.sha256 || (linked && (published.ino !== proof.ino || published.dev !== proof.dev))) {
      await inTransaction(db, driver, () => reviewSteps(driver, op, linked ? "published inode differs from the seal" : "canonical key exists with different bytes"));
      throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Canonical photo key does not match the sealed artifact");
    }
  }
  await options.hooks?.afterPublish?.();

  const photo = await persistFencedUploadedProductPhoto(db, command.productId, {
    filename: op.mainKey, url: `${productPhotoStaticPath}/${op.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${op.thumbKey}`,
    mimeType: "image/webp", sizeBytes: command.file.size, width: prepared.width, height: prepared.height,
  }, command.altText || undefined, { operationId: op.id, generation: op.generation, owner: op.owner, nonce: op.nonce, sealId, photoId: op.photoId, eventId: randomUUID() });
  // Committed: the canonical names (and the row) now own these inodes; the private names are this generation's own.
  await Promise.allSettled([unlink(prepared.main), unlink(prepared.thumb)]);
  await options.hooks?.afterCommit?.();
  return photo;
}

/** Read-only recovery report: every non-committed W2 operation whose lease expired, plus every review item. Never deletes. */
export function listW2OperationsRequiringRecovery(db: DbClient, driver: Driver = driverOf()) {
  return inTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
    const now = nowMs(driver);
    return yield sql`SELECT id, subject_id AS token, generation, state, main_key, thumb_key, seal_id, review_reason FROM photo_operations
      WHERE kind = 'product_upload' AND subject_type = 'w2_request' AND (state = 'review' OR (state IN ('preparing', 'sealed') AND lease_until_ms <= ${now})) ORDER BY created_ms`;
  });
}
