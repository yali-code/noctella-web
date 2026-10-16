import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { PRODUCT_PHOTO_MAX_BYTES, productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { stagedProductPhotoStorage, type StagedProductPhotoInput } from "./stagedProductPhotoStorage";
import { classifyW2UploadIntent, isValidW2UploadIntent, type W2UploadIntent } from "./w2OperationIdentity";
import { getCommittedProductPhoto, persistFencedUploadedProductPhoto } from "./products";
import {
  PHOTO_OPERATION_LEASE_MS, claimExistingOperation, createGenerationDirectory, createOperation, inOwnershipTransaction,
  listPhotoOperationsRequiringRecovery, nowMs, ownershipDriver, photoOperationPrivateRoot, publishSealedArtifacts,
  reviewSteps, sealPreparedArtifacts, uniqueViolation, type OperationClaim, type OwnershipDriver, type Rows,
} from "./photoOperationAuthority";

/**
 * FAZ A / #424: the generation-fenced W2 product-photo owner (used only when PHOTO_OWNERSHIP_FENCING_ENABLED=true),
 * on the shared photo-operation authority (photoOperationAuthority.ts).
 *
 * 1. Claim, one DB transaction: a new request token creates the product_upload operation (deterministic keys from
 *    a fresh target photo id), its first generation and the immutable W2 intent bound to it. A known token:
 *    different intent -> 409; committed -> the committed photo; live lease -> 409; review -> 409; expired -> reclaim.
 * 2. Prepare: the existing staged recipe, path-fed, into an exclusive generation-private directory.
 * 3. Seal, verify and publish without ever replacing a canonical file (photoOperationAuthority).
 * 4. Commit: persistFencedUploadedProductPhoto (photo + promote outbox + generation CAS in one transaction).
 */
export const W2_OPERATION_LEASE_MS = PHOTO_OPERATION_LEASE_MS;
/** Noctella is single-tenant: the intent scope is fixed server-side, never client-supplied. */
const TENANT_SCOPE = "noctella";

export interface FencedUploadCommand { productId: string; actorId: string; operationToken: string; sha256: string; altText: string; file: StagedProductPhotoInput }

function* claimSteps(driver: OwnershipDriver, intent: W2UploadIntent, ttl: number): Generator<SQL, OperationClaim, Rows> {
  const now = nowMs(driver);
  const lock = sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
  const [stored] = yield sql`SELECT token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id FROM photo_w2_upload_intents WHERE token = ${intent.token}${lock}`;
  if (stored) {
    const decision = classifyW2UploadIntent({ kind: "W2_PRODUCT_PHOTO_UPLOAD", token: stored.token, tenantId: stored.tenant_id, actorId: stored.actor_id, productId: stored.product_id, sha256: stored.input_sha256, altText: stored.alt_text }, intent);
    if (decision !== "SAME_INTENT" || !stored.operation_id) return { kind: "conflict" };
    return yield* claimExistingOperation(driver, stored.operation_id, ttl);
  }
  const photoId = randomUUID();
  const op = yield* createOperation(driver, {
    kind: "product_upload", subjectType: "w2_request", subjectId: intent.token, targetPhotoId: photoId,
    mainKey: `${intent.productId}-${photoId}.webp`, thumbKey: `${intent.productId}-${photoId}-thumb.webp`, inputSha256: intent.sha256,
  }, ttl);
  yield sql`INSERT INTO photo_w2_upload_intents (token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id, created_ms)
    VALUES (${intent.token}, ${intent.tenantId}, ${intent.actorId}, ${intent.productId}, ${intent.sha256}, ${intent.altText}, ${op.id}, ${now}) RETURNING token`;
  return { kind: "owned", op };
}

export const w2OperationPrivateRoot = photoOperationPrivateRoot;

/** Test seams for crash/acknowledgement-loss acceptance; never set by the production router. */
export interface FencedUploadHooks { afterSeal?: () => void | Promise<void>; afterPublish?: () => void | Promise<void>; afterCommit?: () => void | Promise<void> }

export async function uploadFencedProductPhoto(db: DbClient, command: FencedUploadCommand, options: { canonicalRoot?: string; driver?: OwnershipDriver; leaseMs?: number; hooks?: FencedUploadHooks } = {}) {
  const driver = options.driver ?? ownershipDriver();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const ttl = options.leaseMs ?? W2_OPERATION_LEASE_MS;
  const intent: W2UploadIntent = { kind: "W2_PRODUCT_PHOTO_UPLOAD", tenantId: TENANT_SCOPE, actorId: command.actorId, productId: command.productId, token: command.operationToken, sha256: command.sha256, altText: command.altText };
  if (!isValidW2UploadIntent(intent) || command.file.size > PRODUCT_PHOTO_MAX_BYTES) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Invalid fenced photo upload");

  let claim: OperationClaim;
  try { claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, intent, ttl)); }
  catch (error) {
    if (!uniqueViolation(error)) throw error;
    // A concurrent first claim of the same token won; classify against the now-committed intent.
    claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, intent, ttl));
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
  const generationDir = await createGenerationDirectory(op, canonicalRoot);
  let prepared: Awaited<ReturnType<typeof stagedProductPhotoStorage.prepareFencedProductPhoto>>;
  try { prepared = await stagedProductPhotoStorage.prepareFencedProductPhoto(command.file, generationDir); }
  catch (error) {
    // A deterministic input rejection (nothing sealed or published) ends this identity; retries of it are 409.
    if (error instanceof PhotoUploadError && (error.status === 400 || error.status === 413))
      await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, `input rejected: ${error.code}`));
    throw error;
  }

  const seal = await sealPreparedArtifacts(db, driver, op, prepared);
  if (!seal) throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before sealing");
  await options.hooks?.afterSeal?.();
  await publishSealedArtifacts(db, driver, op, prepared, seal, canonicalRoot);
  await options.hooks?.afterPublish?.();

  const photo = await persistFencedUploadedProductPhoto(db, command.productId, {
    filename: op.mainKey, url: `${productPhotoStaticPath}/${op.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${op.thumbKey}`,
    mimeType: "image/webp", sizeBytes: command.file.size, width: prepared.width, height: prepared.height,
  }, command.altText || undefined, { operationId: op.id, generation: op.generation, owner: op.owner, nonce: op.nonce, sealId: seal.sealId, photoId: op.photoId, eventId: randomUUID() });
  // Committed: the canonical names (and the row) now own these inodes; the private names are this generation's own.
  await Promise.allSettled([unlink(prepared.main), unlink(prepared.thumb)]);
  await options.hooks?.afterCommit?.();
  return photo;
}

/** Read-only recovery report for W2 operations (expired or review). Never deletes. */
export async function listW2OperationsRequiringRecovery(db: DbClient, driver: OwnershipDriver = ownershipDriver()) {
  return (await listPhotoOperationsRequiringRecovery(db, driver)).filter((row) => row.kind === "product_upload" && row.subject_type === "w2_request");
}
