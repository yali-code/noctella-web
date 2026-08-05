import { randomUUID } from "node:crypto";
import { AiProductIntakeStatus, type AiIntakePhoto } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { BadRequestError } from "./errors";
import { getIntakeById } from "./aiProductIntakes";
import { aiIntakePhotoStorage as defaultStorage, type AiIntakePhotoStorage } from "./aiIntakePhotoStorage";
import { createAiIntakePhotoRepository } from "../repositories/ai-intake-photo/factory";
import type { AiIntakePhotoRecord, AiIntakePhotoRepository } from "../repositories/ai-intake-photo/types";
import {
  createAiIntakePhotoLockedUseCase,
  deleteAiIntakePhotoLockedUseCase,
  listAiIntakePhotosUseCase,
} from "../use-cases/ai-intake-photo/useCases";

function toIntakePhoto(row: AiIntakePhotoRecord): AiIntakePhoto {
  return {
    id: row.id as string,
    intakeId: row.intakeId as string,
    storageKey: row.storageKey as string,
    originalFilename: row.originalFilename as string,
    createdByAdminUserId: row.createdByAdminUserId as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/** Mirrors services/aiProductIntakes.ts's repositoryFor driver-resolution pattern. */
function repositoryFor(db: DbClient): AiIntakePhotoRepository {
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  return createAiIntakePhotoRepository(driver, db);
}

/**
 * Sprint 91 upload sequence (approved), Sprint 93-corrected: verify intake
 * exists and is Open (fast pre-check), validate MIME/size and write the file
 * synchronously (both inside storage.saveIntakePhoto - deliberately outside
 * any database transaction, per the approved lock protocol), then insert the
 * DB row under the same intake-row lock proposal writes use, re-verifying
 * existence/Open status from a fresh read taken inside that lock - not just
 * the earlier pre-check. If that insert fails for any reason (including the
 * atomic guard rejecting a no-longer-Open intake), the newly-written file is
 * deleted before the error propagates. No queue, no outbox, mirroring the
 * try/catch shape already established by services/products.ts's
 * uploadProductPhoto, but fully independent of it.
 */
export async function uploadIntakePhoto(
  db: DbClient,
  intakeId: string,
  file: { buffer: Buffer; mimetype: string; size: number },
  originalFilename: string,
  createdByAdminUserId: string,
  storage: AiIntakePhotoStorage = defaultStorage,
): Promise<AiIntakePhoto> {
  const intake = await getIntakeById(db, intakeId); // throws NotFoundError if missing
  if (intake.status !== AiProductIntakeStatus.Open) {
    throw new BadRequestError(`Only an Open intake can receive staged photos (current status: "${intake.status}")`);
  }

  const stored = await storage.saveIntakePhoto(file);
  try {
    const row = await createAiIntakePhotoLockedUseCase(repositoryFor(db), {
      id: randomUUID(),
      intakeId,
      storageKey: stored.storageKey,
      originalFilename,
      createdByAdminUserId,
    });
    return toIntakePhoto(row);
  } catch (err) {
    await storage.deleteIntakePhoto(stored.storageKey);
    throw err;
  }
}

/** Listing is allowed for a cancelled intake - no status check, only existence. */
export async function listIntakePhotos(db: DbClient, intakeId: string): Promise<AiIntakePhoto[]> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing
  const rows = await listAiIntakePhotosUseCase(repositoryFor(db), intakeId);
  return rows.map(toIntakePhoto);
}

/**
 * Sprint 95 final correction: DB-first staged photo deletion. Deletion is
 * allowed for Open and Cancelled intakes only (Applied/Finalized/
 * unrecognized rejected, fail closed) - status check, ownership check, and
 * the database row delete all happen inside ONE intake-row-lock transaction
 * with NO filesystem mutation of any kind (see
 * deleteAiIntakePhotoLockedUseCase / repositories/ai-intake-photo/drizzle.ts's
 * deleteLockedToIntake). Only after that transaction has genuinely committed
 * does this function delete the physical staged source file.
 *
 * This replaces the prior tombstone/quarantine-before-commit design, which
 * performed a synchronous filesystem rename inside the locked transaction
 * callback so it could be rolled back on failure. That design had an
 * irreducible blind spot: a database COMMIT can fail strictly after the
 * transaction callback has already returned (see better-sqlite3's
 * transaction wrapper), so any restoration logic scoped inside the callback
 * could never observe or compensate for a commit-phase failure. Performing
 * zero filesystem work before commit removes this class of bug entirely
 * instead of trying to catch it: whatever fails before commit (the DELETE
 * statement, a later statement, the COMMIT itself, a PostgreSQL rejection, a
 * process crash) leaves the row and the staged file exactly as they were, so
 * no rollback/restore compensation is ever needed.
 *
 * The only residual failure mode is a crash or error during the post-commit
 * file delete below, which is swallowed rather than surfaced: the DB row is
 * already gone, so a retryable error would make a retry of this same request
 * incorrectly 404, and there is nothing left to roll back. A private orphan
 * source file with no owning row is an explicitly Sprint-96-owned cleanup
 * state, never a data-integrity violation.
 */
export async function deleteIntakePhoto(
  db: DbClient,
  intakeId: string,
  photoId: string,
  storage: AiIntakePhotoStorage = defaultStorage,
): Promise<void> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing
  const repository = repositoryFor(db);
  const deletedPhoto = await deleteAiIntakePhotoLockedUseCase(repository, intakeId, photoId);

  try {
    await storage.deleteIntakePhoto(deletedPhoto.storageKey!);
  } catch {
    // Intentionally swallowed - the logical deletion (the DB row) already
    // committed successfully; see the function comment above for why this
    // must never be surfaced as a request failure.
    // eslint-disable-next-line no-console
    console.error("Staged AI intake photo file cleanup failed after a committed deletion - an orphan private file may remain (Sprint 96 cleanup scope)");
  }
}
