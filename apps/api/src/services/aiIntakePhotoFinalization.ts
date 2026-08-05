import { AiProductIntakeStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getIntakeById } from "./aiProductIntakes";
import { listIntakePhotos } from "./aiIntakePhotos";
import { getProductById } from "./products";
import { AiIntakePhotoFinalizationResultStateInvalidError, NotFoundError } from "./errors";
import { LocalAiIntakePhotoReader } from "../ai-intake/photoReader";
import { createIntakeScopedPhotoStorageKeyResolver } from "./aiIntakePhotoStorageKeyResolver";
import { writeDeterministicProductPhoto } from "./photoStorage";
import {
  createAiIntakePhotoFinalizeTransactionCapabilityForDb,
  type AiIntakePhotoFinalizeTransactionDriver,
} from "./aiIntakePhotoFinalizeTransactionCapabilityForDb";
import {
  buildAiIntakePhotoFinalizationManifest,
  finalizeAiIntakePhotosUseCase,
  type AiIntakePhotoFinalizationManifestDeps,
  type AiIntakePhotoFinalizationManifestEntry,
} from "../use-cases/ai-intake-photo-finalize/useCases";
import type { FinalizeAiIntakePhotosInput as FinalizeAiIntakePhotosRequestInput } from "../validation/aiIntakePhotoFinalize";

export interface FinalizeAiIntakePhotosResult {
  /** false for the idempotent already-Finalized retry - no new canonical write was performed. */
  created: boolean;
  product: Awaited<ReturnType<typeof getProductById>>;
}

/** Sprint 95: default manifest-prep deps - real staged-photo reads and real deterministic canonical writes. Injectable in tests. */
function defaultManifestDeps(db: DbClient, intakeId: string): AiIntakePhotoFinalizationManifestDeps {
  const reader = new LocalAiIntakePhotoReader(createIntakeScopedPhotoStorageKeyResolver(db, intakeId));
  return {
    readStagedPhotoBytes: (stagedPhotoId) => reader.read(stagedPhotoId),
    writeDeterministicPhoto: (photoInput) => writeDeterministicProductPhoto(photoInput),
  };
}

/**
 * Sprint 95: fast pre-check only (404 for a clearly-nonexistent intake, and a
 * heuristic for whether photo files need preparing at all), mirroring
 * services/aiIntakeApply.ts's established pre-check-vs-authoritative-
 * transaction split - the real status/product/staged-set validation happens
 * entirely inside finalizeAiIntakePhotosUseCase's locked transaction. File
 * preparation (reading staged bytes, writing deterministic canonical files)
 * always happens OUTSIDE that transaction, and is skipped entirely unless
 * this pre-check indicates a genuine first attempt (Applied, with a result
 * Product) - an already-Finalized retry never touches the filesystem, and a
 * not-yet-Applied intake has nothing valid to prepare. A stale pre-check can
 * only ever cause a harmless skipped-or-redundant preparation, never an
 * incorrect write, since the authoritative transaction independently
 * re-verifies everything and fails closed if the manifest doesn't match.
 */
export async function finalizeAiIntakePhotos(
  db: DbClient,
  intakeId: string,
  input: FinalizeAiIntakePhotosRequestInput,
  actorId: string,
  manifestDeps: AiIntakePhotoFinalizationManifestDeps = defaultManifestDeps(db, intakeId),
): Promise<FinalizeAiIntakePhotosResult> {
  const precheckIntake = await getIntakeById(db, intakeId); // throws NotFoundError if missing

  let manifest: AiIntakePhotoFinalizationManifestEntry[] | null = null;
  if (precheckIntake.status === AiProductIntakeStatus.Applied && precheckIntake.resultProductId) {
    const stagedPhotos = await listIntakePhotos(db, intakeId);
    manifest = await buildAiIntakePhotoFinalizationManifest(
      manifestDeps,
      stagedPhotos.map((photo) => ({ id: photo.id as string, storageKey: photo.storageKey as string })),
      precheckIntake.resultProductId,
      input.primaryIntakePhotoId,
    );
  }

  const driver = ((process.env.DATABASE_DRIVER as string) || "sqlite") as AiIntakePhotoFinalizeTransactionDriver;
  const capability = createAiIntakePhotoFinalizeTransactionCapabilityForDb(db, driver);

  const result = await finalizeAiIntakePhotosUseCase(capability, { intakeId, actorId, manifest });

  try {
    const product = await getProductById(db, result.productId);
    return { created: result.created, product };
  } catch (err) {
    // Sprint 95: narrowly translated only for the idempotent already-Finalized
    // path - a resultProductId that exists but no longer resolves to a
    // Product is a deterministic conflict, not "not found", and must never
    // be repaired automatically. The first-finalization path's Product read
    // should never realistically 404 (the Product was verified to exist
    // inside the same transaction moments earlier), so it is deliberately
    // not translated here - only the already-Finalized retry path is,
    // mirroring services/aiIntakeApply.ts's identical Sprint 94 correction.
    if (!result.created && err instanceof NotFoundError) {
      throw new AiIntakePhotoFinalizationResultStateInvalidError("This intake's finalized result Product could not be found.");
    }
    throw err;
  }
}
