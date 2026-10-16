import { createHash } from "node:crypto";
import { type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { prepareDeterministicProductPhotoFiles, productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { stagedSourceMimeType } from "./aiIntakeStagedKey";
import {
  PHOTO_OPERATION_LEASE_MS, claimExistingOperation, createGenerationDirectory, createOperation, findOperationBySubject,
  inOwnershipTransaction, ownershipDriver, publishSealedArtifacts, reviewSteps, sealPreparedArtifacts, uniqueViolation,
  type OperationClaim, type OwnershipDriver, type Rows,
} from "./photoOperationAuthority";
import {
  AiIntakePhotoFinalizationNoStagedPhotosError, AiIntakePhotoFinalizationPrimaryInvalidError, AiIntakePhotoFinalizationSourceMissingError, NotFoundError,
} from "./errors";
import type { AiIntakePhotoFinalizationManifestEntry } from "../use-cases/ai-intake-photo-finalize/useCases";
import type { StagedIntakePhotoForFinalization } from "./aiIntakePhotoFinalizeTransactionCapabilityForDb";

/**
 * FAZ A / #424: the generation-fenced W4 AI-intake finalization owner (PHOTO_OWNERSHIP_FENCING_ENABLED=true only),
 * on the shared photo-operation authority used by W2.
 *
 * One ai_finalize operation per staged photo (subject ai_intake_photo:<staged id>): immutable target photo id
 * (= staged id), deterministic keys `${productId}-${stagedId}(.webp|-thumb.webp)` and the staged source SHA-256.
 * A known operation with a different source/keys is never reused (409). The exact legacy W4 recipe produces the
 * derivatives into a generation-private directory; they are sealed, verified and published without replacing any
 * canonical file. Each manifest entry carries its fence proof, committed by the use case in the SAME transaction
 * as the photo row, its promote outbox event and the intake finalization (stale generation -> whole rollback).
 */
export interface W4FencedOptions { driver?: OwnershipDriver; canonicalRoot?: string; leaseMs?: number; hooks?: { afterSeal?: (stagedPhotoId: string) => void | Promise<void>; afterPublish?: (stagedPhotoId: string) => void | Promise<void> } }

function* claimSteps(driver: OwnershipDriver, productId: string, stagedPhotoId: string, inputSha256: string, ttl: number): Generator<SQL, OperationClaim, Rows> {
  const mainKey = `${productId}-${stagedPhotoId}.webp`, thumbKey = `${productId}-${stagedPhotoId}-thumb.webp`;
  const existing = yield* findOperationBySubject(driver, "ai_intake_photo", stagedPhotoId);
  if (existing) {
    if (existing.kind !== "ai_finalize" || existing.target_photo_id !== stagedPhotoId || existing.main_key !== mainKey || existing.thumb_key !== thumbKey || existing.input_sha256 !== inputSha256)
      return { kind: "conflict" };
    return yield* claimExistingOperation(driver, existing.id, ttl);
  }
  const op = yield* createOperation(driver, { kind: "ai_finalize", subjectType: "ai_intake_photo", subjectId: stagedPhotoId, targetPhotoId: stagedPhotoId, mainKey, thumbKey, inputSha256 }, ttl);
  return { kind: "owned", op };
}

export async function buildFencedAiIntakePhotoFinalizationManifest(
  db: DbClient,
  readStagedPhotoBytes: (stagedPhotoId: string) => Promise<Buffer>,
  stagedPhotos: StagedIntakePhotoForFinalization[],
  productId: string,
  primaryIntakePhotoId: string | undefined,
  options: W4FencedOptions = {},
): Promise<{ manifest: AiIntakePhotoFinalizationManifestEntry[]; privateFiles: string[] }> {
  const driver = options.driver ?? ownershipDriver();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const ttl = options.leaseMs ?? PHOTO_OPERATION_LEASE_MS;
  if (stagedPhotos.length === 0) throw new AiIntakePhotoFinalizationNoStagedPhotosError();
  const primaryId = primaryIntakePhotoId ?? stagedPhotos[0].id;
  if (!stagedPhotos.some((photo) => photo.id === primaryId)) throw new AiIntakePhotoFinalizationPrimaryInvalidError();

  const manifest: AiIntakePhotoFinalizationManifestEntry[] = [];
  const privateFiles: string[] = [];
  for (const [index, staged] of stagedPhotos.entries()) {
    let bytes: Buffer;
    try { bytes = await readStagedPhotoBytes(staged.id); }
    catch (err) {
      if (err instanceof NotFoundError || (err as { code?: string })?.code === "ENOENT")
        throw new AiIntakePhotoFinalizationSourceMissingError(`Staged photo "${staged.id}"'s source file could not be read.`);
      throw err;
    }
    const inputSha256 = createHash("sha256").update(bytes).digest("hex");

    let claim: OperationClaim;
    try { claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, productId, staged.id, inputSha256, ttl)); }
    catch (error) {
      if (!uniqueViolation(error)) throw error;
      claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, productId, staged.id, inputSha256, ttl));
    }
    // A committed operation implies its intake was finalized in that same transaction: the use case's Finalized
    // branch answers it without this manifest, so no new files or fences are produced for it.
    if (claim.kind === "committed") return { manifest: [], privateFiles };
    if (claim.kind === "conflict") throw new PhotoUploadError(409, "PHOTO_OPERATION_CONFLICT", "A different photo operation already owns this staged photo");
    if (claim.kind === "in-progress") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo finalization is already in progress");
    if (claim.kind !== "owned") throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo finalization requires operator review");
    const op = claim.op;

    const generationDir = await createGenerationDirectory(op, canonicalRoot);
    let prepared: Awaited<ReturnType<typeof prepareDeterministicProductPhotoFiles>>;
    try { prepared = await prepareDeterministicProductPhotoFiles({ buffer: bytes, mimetype: stagedSourceMimeType(staged.storageKey), size: bytes.length }, generationDir); }
    catch (error) {
      if (error && typeof error === "object" && (error as { status?: number }).status === 400)
        await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, "staged source rejected by the W4 recipe"));
      throw error;
    }
    const seal = await sealPreparedArtifacts(db, driver, op, prepared);
    if (!seal) throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before sealing");
    await options.hooks?.afterSeal?.(staged.id);
    await publishSealedArtifacts(db, driver, op, prepared, seal, canonicalRoot);
    await options.hooks?.afterPublish?.(staged.id);
    privateFiles.push(prepared.main, prepared.thumb);

    manifest.push({
      stagedPhotoId: staged.id, stagedStorageKey: staged.storageKey, productPhotoId: staged.id,
      mainStorageKey: op.mainKey, thumbnailStorageKey: op.thumbKey,
      url: `${productPhotoStaticPath}/${op.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${op.thumbKey}`,
      mimeType: "image/webp", sizeBytes: bytes.length, width: prepared.width, height: prepared.height,
      sortOrder: index, isPrimary: staged.id === primaryId,
      fence: { operationId: op.id, generation: op.generation, owner: op.owner, nonce: op.nonce, sealId: seal.sealId, photoId: op.photoId },
    });
  }
  return { manifest, privateFiles };
}
