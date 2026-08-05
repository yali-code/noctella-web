import { randomUUID } from "node:crypto";
import { AiProductIntakeStatus, ProductStatus } from "@noctella/shared";
import {
  AiIntakePhotoFinalizationNoStagedPhotosError,
  AiIntakePhotoFinalizationNotAppliedError,
  AiIntakePhotoFinalizationPrimaryInvalidError,
  AiIntakePhotoFinalizationProductNotDraftError,
  AiIntakePhotoFinalizationProductPhotosExistError,
  AiIntakePhotoFinalizationResultStateInvalidError,
  AiIntakePhotoFinalizationSourceMissingError,
  AiIntakePhotoFinalizationStateInvalidError,
  NotFoundError,
} from "../../services/errors";
import { OutboxEventStatus, OutboxEventType } from "../../services/outbox";
import type { DeterministicProductPhotoInput, DeterministicProductPhotoResult } from "../../services/photoStorage";
import type {
  AiIntakePhotoFinalizeTransactionCapability,
  StagedIntakePhotoForFinalization,
} from "../../services/aiIntakePhotoFinalizeTransactionCapabilityForDb";

const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> => (value instanceof Promise ? value.then(next) : next(value));
const bool = (v: unknown) => v === true || v === 1;

/**
 * Sequentially chains a step over each item, staying fully synchronous when
 * every step is synchronous (SQLite) and awaiting in order when a step
 * returns a Promise (PostgreSQL) - never Promise.all, so this stays
 * compatible with the SQLite transaction callback's "zero await/Promise
 * boundary" requirement whenever every step happens to resolve synchronously.
 */
function chainSequence<T>(items: T[], step: (item: T, index: number) => unknown | Promise<unknown>): unknown | Promise<unknown> {
  function loop(index: number): unknown | Promise<unknown> {
    if (index >= items.length) return undefined;
    return chain(step(items[index], index), () => loop(index + 1));
  }
  return loop(0);
}

export interface AiIntakePhotoFinalizationManifestEntry {
  stagedPhotoId: string;
  stagedStorageKey: string;
  /** Deterministic canonical ProductPhoto id - always equal to stagedPhotoId. */
  productPhotoId: string;
  mainStorageKey: string;
  thumbnailStorageKey: string;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sortOrder: number;
  isPrimary: boolean;
}

export interface AiIntakePhotoFinalizationManifestDeps {
  /** Reads a staged photo's real bytes from the private staging root. */
  readStagedPhotoBytes(stagedPhotoId: string): Promise<Buffer>;
  /** Writes the deterministic main+thumbnail canonical files, idempotently. */
  writeDeterministicPhoto(input: DeterministicProductPhotoInput): Promise<DeterministicProductPhotoResult>;
}

/**
 * Sprint 95: prepares canonical photo files OUTSIDE any DB transaction - so
 * CPU-bound Sharp processing and filesystem writes never hold a database
 * lock. Deterministic ProductPhoto ids/destination keys are derived only
 * from stable, server-owned values (the staged photo's own id, the target
 * Product id) - never a fresh random UUID - so a repeated call after a
 * crash or lost response re-derives the exact same manifest and safely
 * reuses (rather than duplicates) any already-written files via
 * writeDeterministicPhoto's own same-bytes/different-bytes idempotency.
 * Validates primaryIntakePhotoId against the staged set actually read here
 * (400 if it doesn't belong) - the authoritative transaction re-validates
 * that this same staged set is still current before using this manifest.
 */
export async function buildAiIntakePhotoFinalizationManifest(
  deps: AiIntakePhotoFinalizationManifestDeps,
  stagedPhotos: StagedIntakePhotoForFinalization[],
  productId: string,
  primaryIntakePhotoId: string | undefined,
): Promise<AiIntakePhotoFinalizationManifestEntry[]> {
  if (stagedPhotos.length === 0) throw new AiIntakePhotoFinalizationNoStagedPhotosError();

  let primaryId = primaryIntakePhotoId;
  if (primaryId !== undefined) {
    if (!stagedPhotos.some((photo) => photo.id === primaryId)) throw new AiIntakePhotoFinalizationPrimaryInvalidError();
  } else {
    primaryId = stagedPhotos[0].id;
  }

  const entries: AiIntakePhotoFinalizationManifestEntry[] = [];
  for (const [index, staged] of stagedPhotos.entries()) {
    let bytes: Buffer;
    try {
      bytes = await deps.readStagedPhotoBytes(staged.id);
    } catch (err) {
      if (err instanceof NotFoundError || (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")) {
        throw new AiIntakePhotoFinalizationSourceMissingError(`Staged photo "${staged.id}"'s source file could not be read.`);
      }
      throw err;
    }

    const mainStorageKey = `${productId}-${staged.id}.webp`;
    const thumbnailStorageKey = `${productId}-${staged.id}-thumb.webp`;
    const written = await deps.writeDeterministicPhoto({
      buffer: bytes,
      mimetype: "image/webp",
      size: bytes.length,
      mainStorageKey,
      thumbnailStorageKey,
    });

    entries.push({
      stagedPhotoId: staged.id,
      stagedStorageKey: staged.storageKey,
      productPhotoId: staged.id,
      mainStorageKey: written.mainStorageKey,
      thumbnailStorageKey: written.thumbnailStorageKey,
      url: written.url,
      thumbnailUrl: written.thumbnailUrl,
      mimeType: written.mimeType,
      sizeBytes: written.sizeBytes,
      width: written.width,
      height: written.height,
      sortOrder: index,
      isPrimary: staged.id === primaryId,
    });
  }
  return entries;
}

function manifestMatchesStagedPhotos(manifest: AiIntakePhotoFinalizationManifestEntry[], stagedPhotos: StagedIntakePhotoForFinalization[]): boolean {
  if (manifest.length !== stagedPhotos.length) return false;
  return manifest.every((entry, index) => entry.stagedPhotoId === stagedPhotos[index].id && entry.stagedStorageKey === stagedPhotos[index].storageKey);
}

export interface FinalizeAiIntakePhotosInput {
  intakeId: string;
  actorId: string;
  /**
   * Null when the pre-transaction status heuristic determined no file
   * preparation was needed (already Finalized, or not yet Applied) - the
   * authoritative branch below never uses a null manifest for a first
   * finalization attempt (it fails closed with AiIntakePhotoFinalizationStateInvalidError
   * instead), so a stale heuristic can never cause an incorrect write.
   */
  manifest: AiIntakePhotoFinalizationManifestEntry[] | null;
}

export interface FinalizeAiIntakePhotosResult {
  /** false for the idempotent already-Finalized retry path - no new writes were performed. */
  created: boolean;
  productId: string;
}

/**
 * Sprint 95: the single authoritative finalize-photos transaction. Locks the
 * intake row first, then the Product row (once resultProductId is known),
 * then performs every remaining validation and write from data read inside
 * that same lock - never a pre-lock read - mirroring Sprint 93/94's
 * TOCTOU-closing precedent. An already-Finalized intake is idempotent (no
 * writes, existing result validated for consistency); Open/Cancelled is
 * rejected; Applied-with-inconsistent-manifest fails closed rather than
 * risk creating anything from stale prepared files.
 */
export async function finalizeAiIntakePhotosUseCase(
  capability: AiIntakePhotoFinalizeTransactionCapability,
  input: FinalizeAiIntakePhotosInput,
): Promise<FinalizeAiIntakePhotosResult> {
  return capability.runWithLockedIntake(input.intakeId, (ctx) => {
    const { intake } = ctx;
    if (!intake) throw new NotFoundError("AI product intake not found");

    if (intake.status === AiProductIntakeStatus.Finalized) {
      if (!intake.resultProductId) throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Finalized but has no result Product recorded.");
      if (!intake.finalizedAt || !intake.finalizedByAdminUserId) {
        throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Finalized but is missing finalization audit fields.");
      }
      const productId = intake.resultProductId as string;
      return chain(ctx.lockProduct(productId), (product) => {
        if (!product) throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake's finalized result Product could not be found.");
        return chain(ctx.readOrderedStagedPhotos(), (stagedPhotos) =>
          chain(ctx.listExistingProductPhotos(productId), (existingPhotos: any[]) => {
            if (existingPhotos.length === 0) throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Finalized but has no canonical photos.");
            const primaryCount = existingPhotos.filter((photo: any) => bool(photo.isPrimary)).length;
            if (primaryCount !== 1) {
              throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Finalized but does not have exactly one Primary photo.");
            }
            const existingIds = new Set(existingPhotos.map((photo: any) => String(photo.id)));
            if (!stagedPhotos.every((photo) => existingIds.has(photo.id))) {
              throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Finalized but is missing one or more expected canonical photos.");
            }
            return { created: false, productId };
          }),
        );
      });
    }

    if (intake.status !== AiProductIntakeStatus.Applied) {
      throw new AiIntakePhotoFinalizationNotAppliedError();
    }
    if (!intake.resultProductId) {
      throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake is Applied but has no result Product recorded.");
    }
    const productId = intake.resultProductId as string;

    return chain(ctx.lockProduct(productId), (product) => {
      if (!product) throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake's result Product could not be found.");
      if (product.status !== ProductStatus.Draft) throw new AiIntakePhotoFinalizationProductNotDraftError();

      return chain(ctx.listExistingProductPhotos(productId), (existingPhotos: any[]) => {
        if (existingPhotos.length > 0) throw new AiIntakePhotoFinalizationProductPhotosExistError();

        return chain(ctx.readOrderedStagedPhotos(), (stagedPhotos) => {
          if (stagedPhotos.length === 0) throw new AiIntakePhotoFinalizationNoStagedPhotosError();

          const manifest = input.manifest;
          if (!manifest || !manifestMatchesStagedPhotos(manifest, stagedPhotos)) {
            throw new AiIntakePhotoFinalizationStateInvalidError();
          }

          const manifestIds = manifest.map((entry) => entry.productPhotoId);
          return chain(ctx.findExistingProductPhotosByIds(manifestIds), (colliding: any[]) => {
            if (colliding.length > 0) {
              throw new AiIntakePhotoFinalizationStateInvalidError(
                "A canonical photo already exists at a deterministic id this finalization would use.",
              );
            }

            const now = new Date().toISOString();
            return chain(
              chainSequence(manifest, (entry) =>
                ctx.createProductPhoto({
                  values: {
                    id: entry.productPhotoId,
                    productId,
                    url: entry.url,
                    thumbnailUrl: entry.thumbnailUrl,
                    altText: null,
                    sortOrder: entry.sortOrder,
                    isPrimary: entry.isPrimary,
                    filename: entry.mainStorageKey,
                    mimeType: entry.mimeType,
                    sizeBytes: entry.sizeBytes,
                    width: entry.width,
                    height: entry.height,
                    processingStatus: "Processing",
                    storageKey: entry.mainStorageKey,
                    thumbnailStorageKey: entry.thumbnailStorageKey,
                    processingUpdatedAt: now,
                    createdAt: now,
                    updatedAt: now,
                  },
                  outboxEvent: {
                    id: randomUUID(),
                    eventType: OutboxEventType.ProductPhotoPromoteRequested,
                    aggregateType: "ProductPhoto",
                    aggregateId: entry.productPhotoId,
                    idempotencyKey: `product-photo-promote:${entry.productPhotoId}`,
                    payload: JSON.stringify({ photoId: entry.productPhotoId, productId }),
                    status: OutboxEventStatus.Pending,
                    attemptCount: 0,
                    maxAttempts: 3,
                    availableAt: now,
                    createdAt: now,
                    updatedAt: now,
                  },
                }),
              ),
              () =>
                chain(
                  ctx.finalizeIntake({ finalizedAt: now, finalizedByAdminUserId: input.actorId, updatedAt: now }),
                  (finalizeResult) => {
                    // Defensive only - the intake row is already locked for the whole transaction, so
                    // this should never fail given the checks above already passed.
                    if (!finalizeResult.updated) throw new AiIntakePhotoFinalizationResultStateInvalidError();
                    return { created: true, productId };
                  },
                ),
            );
          });
        });
      });
    });
  }) as Promise<FinalizeAiIntakePhotosResult>;
}
