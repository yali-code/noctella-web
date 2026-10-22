import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { PRODUCT_PHOTO_MAX_BYTES, productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { stagedProductPhotoStorage, type StagedProductPhotoInput } from "./stagedProductPhotoStorage";
import { classifyW2UploadIntent, isValidW2UploadIntent, type W2UploadIntent } from "./w2OperationIdentity";
import { getCommittedProductPhoto, persistFencedUploadedProductPhoto } from "./products";
import {
  PHOTO_OPERATION_LEASE_MS, createGenerationDirectory, createOperation, inOwnershipTransaction,
  listPhotoOperationsRequiringRecovery, nowMs, ownershipDriver, photoOperationPrivateRoot,
  reviewSteps, sealPreparedArtifacts, uniqueViolation, type OperationClaim, type OwnershipDriver, type Rows,
} from "./photoOperationAuthority";
import { acquirePublicationIntent, guardedReclaimSteps, type PublicationAuthority } from "./photoPublicationIntents";
import {
  assertPhotoPublicationReady, cleanupCommittedPublication, openPublicationScope, publishAuthorizedArtifacts, publishedMainDimensions,
  resumeAfterAuthenticatedExit, sealedArtifactPath,
} from "./photoPublicationExecutor";
import type { CopyPhase } from "./photoCopyPublisher";
import { photoPreparationConfinementConfig, prepareInConfinedWorker, withPreparationJobDir } from "./photoPreparationConfinement";

/**
 * FAZ A / #424: the generation-fenced W2 product-photo owner (used only when PHOTO_OWNERSHIP_FENCING_ENABLED=true),
 * on the shared photo-operation authority (photoOperationAuthority.ts).
 *
 * 1. Claim, one DB transaction: a new request token creates the product_upload operation (deterministic keys from
 *    a fresh target photo id), its first generation and the immutable W2 intent bound to it. A known token:
 *    different intent -> 409; committed -> the committed photo; live lease -> 409; review -> 409; expired -> reclaim.
 *    A known operation is reclaimed only through the guarded reclaim: never while a publication intent is authorized.
 * 2. Prepare: the existing staged recipe, path-fed, into an exclusive generation-private directory.
 * 3. Seal, then T1: a durable, non-expiring publication intent (live lease required) BEFORE any canonical name.
 * 4. Publish publisher-owned verified copies (photoPublicationExecutor/photoCopyPublisher); worker inodes are never linked.
 * 5. Commit: persistFencedUploadedProductPhoto (photo + promote outbox + intent-authorized CAS in one transaction).
 * An authorized intent left by an ended or terminated executor is resumed only after authenticated exit + transfer
 * (Stage 5 F2, #472); an executor that may still be alive keeps the operation BLOCKED (409 in progress).
 */
export const W2_OPERATION_LEASE_MS = PHOTO_OPERATION_LEASE_MS;
/** Noctella is single-tenant: the intent scope is fixed server-side, never client-supplied. */
const TENANT_SCOPE = "noctella";

export interface FencedUploadCommand { productId: string; actorId: string; operationToken: string; sha256: string; altText: string; file: StagedProductPhotoInput }

type W2Claim = OperationClaim & { operationId?: string };

function* claimSteps(driver: OwnershipDriver, intent: W2UploadIntent, ttl: number): Generator<SQL, W2Claim, Rows> {
  const now = nowMs(driver);
  const lock = sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
  const [stored] = yield sql`SELECT token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id FROM photo_w2_upload_intents WHERE token = ${intent.token}${lock}`;
  if (stored) {
    const decision = classifyW2UploadIntent({ kind: "W2_PRODUCT_PHOTO_UPLOAD", token: stored.token, tenantId: stored.tenant_id, actorId: stored.actor_id, productId: stored.product_id, sha256: stored.input_sha256, altText: stored.alt_text }, intent);
    if (decision !== "SAME_INTENT" || !stored.operation_id) return { kind: "conflict" };
    return { ...(yield* guardedReclaimSteps(driver, stored.operation_id, ttl)), operationId: stored.operation_id };
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
export interface FencedUploadHooks {
  afterSeal?: () => void | Promise<void>; afterIntent?: () => void | Promise<void>; copyPhase?: (artifact: "main" | "thumb", phase: CopyPhase) => void | Promise<void>;
  afterPublish?: () => void | Promise<void>; afterCommit?: () => void | Promise<void>;
}

export async function uploadFencedProductPhoto(db: DbClient, command: FencedUploadCommand, options: { canonicalRoot?: string; driver?: OwnershipDriver; leaseMs?: number; hooks?: FencedUploadHooks } = {}) {
  const driver = options.driver ?? ownershipDriver();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const ttl = options.leaseMs ?? W2_OPERATION_LEASE_MS;
  const intent: W2UploadIntent = { kind: "W2_PRODUCT_PHOTO_UPLOAD", tenantId: TENANT_SCOPE, actorId: command.actorId, productId: command.productId, token: command.operationToken, sha256: command.sha256, altText: command.altText };
  if (!isValidW2UploadIntent(intent) || command.file.size > PRODUCT_PHOTO_MAX_BYTES) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Invalid fenced photo upload");
  // Protected publication is the only fenced path: missing prerequisites refuse (503), never fall back.
  await assertPhotoPublicationReady(db, driver, canonicalRoot);

  const scope = openPublicationScope();
  try {
    let claim: W2Claim;
    try { claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, intent, ttl)); }
    catch (error) {
      if (!uniqueViolation(error)) throw error;
      // A concurrent first claim of the same token won; classify against the now-committed intent.
      claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, intent, ttl));
    }
    if (claim.kind === "committed") return await committedPhoto(db, command.productId, claim.photoId);
    if (claim.kind === "conflict") throw new PhotoUploadError(409, "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different photo upload");
    if (claim.kind === "in-progress") {
      // An authorized intent is resumed only after its executor's termination is authenticated (never on lease expiry).
      const resumed = await resumeAfterAuthenticatedExit(db, driver, claim.operationId!, scope);
      if (resumed.kind === "terminal") return await reclassifyTerminal(db, driver, intent, ttl, command.productId);
      if (resumed.kind !== "own") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo upload is already in progress");
      const [row] = await inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
        return yield sql`SELECT target_photo_id FROM photo_operations WHERE id = ${resumed.authority.operationId}`;
      });
      await options.hooks?.afterIntent?.();
      return await publishAndCommit(db, driver, resumed.authority, String(row.target_photo_id), command, canonicalRoot, options.hooks, null);
    }
    if (claim.kind !== "owned") throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo upload requires operator review");
    const op = claim.op;

    // Generation-private, path-fed preparation (the full original is never read into a Buffer here).
    const generationDir = await createGenerationDirectory(op, canonicalRoot);
    let prepared: Awaited<ReturnType<typeof stagedProductPhotoStorage.prepareFencedProductPhoto>>;
    const confinement = photoPreparationConfinementConfig();
    try {
      prepared = confinement.mode === "confined"
        ? await withPreparationJobDir(generationDir, (jobDir) => prepareInConfinedWorker(confinement.launcher, {
          kind: "w2", inputPath: command.file.path, workDir: command.file.workDir, size: command.file.size, mimetype: command.file.mimetype, outDir: generationDir,
        }, jobDir, { signal: command.file.signal }))
        : await stagedProductPhotoStorage.prepareFencedProductPhoto(command.file, generationDir);
    }
    catch (error) {
      // A deterministic input rejection (nothing sealed or published) ends this identity; retries of it are 409.
      if (error instanceof PhotoUploadError && (error.status === 400 || error.status === 413))
        await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, `input rejected: ${error.code}`));
      throw error;
    }
    const at = { operationId: op.id, generation: op.generation };
    if (prepared.main !== sealedArtifactPath(canonicalRoot, at, "main") || prepared.thumb !== sealedArtifactPath(canonicalRoot, at, "thumb"))
      throw new Error("PHOTO_OPERATION_PRIVATE_LAYOUT_UNEXPECTED");

    const seal = await sealPreparedArtifacts(db, driver, op, prepared);
    if (!seal) throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before sealing");
    await options.hooks?.afterSeal?.();
    // T1: durable publication authority BEFORE any canonical name. A reclaimed (stale) generation is rejected here.
    const t1 = await acquirePublicationIntent(db, driver, op, seal.sealId, scope.executor());
    if (t1.kind === "held-by-other") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo upload is already in progress");
    // Same contract as a stale publisher before: retryable 503; a retry returns the successor's committed photo.
    if (t1.kind !== "own") throw new PhotoUploadError(503, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before publication");
    await options.hooks?.afterIntent?.();
    return await publishAndCommit(db, driver, t1.authority, op.photoId, command, canonicalRoot, options.hooks, { width: prepared.width, height: prepared.height });
  } finally { scope.close(); }
}

async function committedPhoto(db: DbClient, productId: string, photoId: string) {
  const photo = await getCommittedProductPhoto(db, productId, photoId);
  if (!photo) throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Committed photo operation requires review");
  return photo;
}

/** The intent became terminal while we looked (committed by its executor or moved to review): answer durably. */
async function reclassifyTerminal(db: DbClient, driver: OwnershipDriver, intent: W2UploadIntent, ttl: number, productId: string) {
  const claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, intent, ttl));
  if (claim.kind === "committed") return committedPhoto(db, productId, claim.photoId);
  throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo upload requires operator review");
}

/** Copy-owned publication by the current intent executor, then the intent-authorized T2 (photo + promote outbox). */
async function publishAndCommit(db: DbClient, driver: OwnershipDriver, authority: PublicationAuthority, photoId: string, command: FencedUploadCommand,
  canonicalRoot: string, hooks: FencedUploadHooks | undefined, dimensions: { width: number; height: number } | null) {
  await publishAuthorizedArtifacts(db, driver, authority, canonicalRoot, hooks?.copyPhase);
  await hooks?.afterPublish?.();
  const { width, height } = dimensions ?? await publishedMainDimensions(canonicalRoot, authority.mainKey);
  const photo = await persistFencedUploadedProductPhoto(db, command.productId, {
    filename: authority.mainKey, url: `${productPhotoStaticPath}/${authority.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${authority.thumbKey}`,
    mimeType: "image/webp", sizeBytes: command.file.size, width, height,
  }, command.altText || undefined, {
    operationId: authority.operationId, generation: authority.generation, owner: authority.owner, nonce: authority.nonce, sealId: authority.sealId,
    photoId, eventId: randomUUID(), intent: { epoch: authority.epoch, token: authority.token, executorIdentity: authority.executorIdentity },
  });
  // Committed: the historical cleanup hook now retains private derivatives and publication anchors (Gate 5).
  await cleanupCommittedPublication(canonicalRoot, authority);
  await hooks?.afterCommit?.();
  return photo;
}

/** Read-only recovery report for W2 operations (expired or review). Never deletes. */
export async function listW2OperationsRequiringRecovery(db: DbClient, driver: OwnershipDriver = ownershipDriver()) {
  return (await listPhotoOperationsRequiringRecovery(db, driver)).filter((row) => row.kind === "product_upload" && row.subject_type === "w2_request");
}
