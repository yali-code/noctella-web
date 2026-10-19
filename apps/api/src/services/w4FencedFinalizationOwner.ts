import { createHash } from "node:crypto";
import { type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { prepareDeterministicProductPhotoFiles, productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { stagedSourceMimeType } from "./aiIntakeStagedKey";
import {
  PHOTO_OPERATION_LEASE_MS, createGenerationDirectory, createOperation, findOperationBySubject,
  inOwnershipTransaction, ownershipDriver, reviewSteps, sealPreparedArtifacts, uniqueViolation,
  type OperationClaim, type OwnershipDriver, type Rows,
} from "./photoOperationAuthority";
import { acquirePublicationIntent, guardedReclaimSteps, type PublicationAuthority } from "./photoPublicationIntents";
import {
  assertPhotoPublicationReady, openPublicationScope, publishAuthorizedArtifacts, publishedMainDimensions, resumeAfterAuthenticatedExit,
  sealedArtifactPath, type PublicationScope,
} from "./photoPublicationExecutor";
import type { CopyPhase } from "./photoCopyPublisher";
import { photoPreparationConfinementConfig, prepareInConfinedWorker, withPreparationJobDir } from "./photoPreparationConfinement";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
 * derivatives into a generation-private directory; they are sealed, then (Stage 5 F2, #472) authorized by a durable
 * publication intent (T1) and published as publisher-owned verified copies without replacing any canonical file. Each
 * manifest entry carries its intent-authorized fence proof, committed by the use case in the SAME transaction as the
 * photo row, its promote outbox event and the intake finalization (lost authority -> whole rollback). Reclaim is
 * guarded (never while an intent is authorized); an intent left by an ended/terminated executor is resumed only after
 * authenticated exit + transfer.
 */
export interface W4FencedOptions {
  driver?: OwnershipDriver; canonicalRoot?: string; leaseMs?: number;
  /** The caller's execution scope; it must stay open until the finalization transaction has settled. */
  scope?: PublicationScope;
  hooks?: {
    afterSeal?: (stagedPhotoId: string) => void | Promise<void>; afterIntent?: (stagedPhotoId: string) => void | Promise<void>;
    copyPhase?: (stagedPhotoId: string, artifact: "main" | "thumb", phase: CopyPhase) => void | Promise<void>;
    afterPublish?: (stagedPhotoId: string) => void | Promise<void>;
  };
}
type W4Claim = OperationClaim & { operationId?: string };

function* claimSteps(driver: OwnershipDriver, productId: string, stagedPhotoId: string, inputSha256: string, ttl: number): Generator<SQL, W4Claim, Rows> {
  const mainKey = `${productId}-${stagedPhotoId}.webp`, thumbKey = `${productId}-${stagedPhotoId}-thumb.webp`;
  const existing = yield* findOperationBySubject(driver, "ai_intake_photo", stagedPhotoId);
  if (existing) {
    if (existing.kind !== "ai_finalize" || existing.target_photo_id !== stagedPhotoId || existing.main_key !== mainKey || existing.thumb_key !== thumbKey || existing.input_sha256 !== inputSha256)
      return { kind: "conflict" };
    return { ...(yield* guardedReclaimSteps(driver, existing.id, ttl)), operationId: existing.id };
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
): Promise<{ manifest: AiIntakePhotoFinalizationManifestEntry[]; privateFiles: string[]; publications: PublicationAuthority[] }> {
  const driver = options.driver ?? ownershipDriver();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const ttl = options.leaseMs ?? PHOTO_OPERATION_LEASE_MS;
  if (stagedPhotos.length === 0) throw new AiIntakePhotoFinalizationNoStagedPhotosError();
  const primaryId = primaryIntakePhotoId ?? stagedPhotos[0].id;
  if (!stagedPhotos.some((photo) => photo.id === primaryId)) throw new AiIntakePhotoFinalizationPrimaryInvalidError();

  await assertPhotoPublicationReady(db, driver, canonicalRoot); // fail closed; never the worker-inode primitive
  const scope = options.scope ?? openPublicationScope();
  try {
    const manifest: AiIntakePhotoFinalizationManifestEntry[] = [];
    const privateFiles: string[] = [];
    const publications: PublicationAuthority[] = [];
    for (const [index, staged] of stagedPhotos.entries()) {
      let bytes: Buffer;
      try { bytes = await readStagedPhotoBytes(staged.id); }
      catch (err) {
        if (err instanceof NotFoundError || (err as { code?: string })?.code === "ENOENT")
          throw new AiIntakePhotoFinalizationSourceMissingError(`Staged photo "${staged.id}"'s source file could not be read.`);
        throw err;
      }
      const inputSha256 = createHash("sha256").update(bytes).digest("hex");

      let claim: W4Claim;
      try { claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, productId, staged.id, inputSha256, ttl)); }
      catch (error) {
        if (!uniqueViolation(error)) throw error;
        claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, productId, staged.id, inputSha256, ttl));
      }
      // A committed operation implies its intake was finalized in that same transaction: the use case's Finalized
      // branch answers it without this manifest, so no new files or fences are produced for it.
      if (claim.kind === "committed") return { manifest: [], privateFiles, publications: [] };
      if (claim.kind === "conflict") throw new PhotoUploadError(409, "PHOTO_OPERATION_CONFLICT", "A different photo operation already owns this staged photo");
      let authority: PublicationAuthority, dimensions: { width: number; height: number } | null = null;
      if (claim.kind === "in-progress") {
        // An authorized intent is resumed only after its executor's termination is authenticated (never on lease expiry).
        const resumed = await resumeAfterAuthenticatedExit(db, driver, claim.operationId!, scope);
        if (resumed.kind === "terminal") {
          const again = await inOwnershipTransaction(db, driver, () => claimSteps(driver, productId, staged.id, inputSha256, ttl));
          if (again.kind === "committed") return { manifest: [], privateFiles, publications: [] };
          throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo finalization requires operator review");
        }
        if (resumed.kind !== "own") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo finalization is already in progress");
        authority = resumed.authority;
      } else {
        if (claim.kind !== "owned") throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "This photo finalization requires operator review");
        const op = claim.op;
        const generationDir = await createGenerationDirectory(op, canonicalRoot);
        let prepared: Awaited<ReturnType<typeof prepareDeterministicProductPhotoFiles>>;
        const confinement = photoPreparationConfinementConfig(), mimetype = stagedSourceMimeType(staged.storageKey);
        try {
          prepared = confinement.mode === "confined"
            ? await withPreparationJobDir(generationDir, async (jobDir) => {
              const inputPath = path.join(jobDir, "source");
              await writeFile(inputPath, bytes, { flag: "wx", mode: 0o600 });
              return prepareInConfinedWorker(confinement.launcher, { kind: "w4", inputPath, size: bytes.length, mimetype, outDir: generationDir }, jobDir);
            })
            : await prepareDeterministicProductPhotoFiles({ buffer: bytes, mimetype, size: bytes.length }, generationDir);
        }
        catch (error) {
          if (error && typeof error === "object" && (error as { status?: number }).status === 400)
            await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, "staged source rejected by the W4 recipe"));
          throw error;
        }
        const at = { operationId: op.id, generation: op.generation };
        if (prepared.main !== sealedArtifactPath(canonicalRoot, at, "main") || prepared.thumb !== sealedArtifactPath(canonicalRoot, at, "thumb"))
          throw new Error("PHOTO_OPERATION_PRIVATE_LAYOUT_UNEXPECTED");
        const seal = await sealPreparedArtifacts(db, driver, op, prepared);
        if (!seal) throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before sealing");
        await options.hooks?.afterSeal?.(staged.id);
        // T1: durable publication authority BEFORE any canonical name. A reclaimed (stale) generation is rejected here.
        const t1 = await acquirePublicationIntent(db, driver, op, seal.sealId, scope.executor());
        if (t1.kind === "held-by-other") throw new PhotoUploadError(409, "PHOTO_OPERATION_IN_PROGRESS", "This photo finalization is already in progress");
        if (t1.kind !== "own") throw new PhotoUploadError(503, "PHOTO_OPERATION_FENCE_LOST", "Photo operation ownership was lost before publication");
        authority = t1.authority;
        dimensions = { width: prepared.width, height: prepared.height };
      }
      await options.hooks?.afterIntent?.(staged.id);
      await publishAuthorizedArtifacts(db, driver, authority, canonicalRoot, (artifact, phase) => options.hooks?.copyPhase?.(staged.id, artifact, phase));
      await options.hooks?.afterPublish?.(staged.id);
      const { width, height } = dimensions ?? await publishedMainDimensions(canonicalRoot, authority.mainKey);
      privateFiles.push(sealedArtifactPath(canonicalRoot, authority, "main"), sealedArtifactPath(canonicalRoot, authority, "thumb"));
      publications.push(authority);

      manifest.push({
        stagedPhotoId: staged.id, stagedStorageKey: staged.storageKey, productPhotoId: staged.id,
        mainStorageKey: authority.mainKey, thumbnailStorageKey: authority.thumbKey,
        url: `${productPhotoStaticPath}/${authority.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${authority.thumbKey}`,
        mimeType: "image/webp", sizeBytes: bytes.length, width, height,
        sortOrder: index, isPrimary: staged.id === primaryId,
        fence: {
          operationId: authority.operationId, generation: authority.generation, owner: authority.owner, nonce: authority.nonce, sealId: authority.sealId, photoId: staged.id,
          intent: { epoch: authority.epoch, token: authority.token, executorIdentity: authority.executorIdentity },
        },
      });
    }
    return { manifest, privateFiles, publications };
  } finally { if (!options.scope) scope.close(); }
}
