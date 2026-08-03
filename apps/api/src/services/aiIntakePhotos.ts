import { randomUUID } from "node:crypto";
import { AiProductIntakeStatus, type AiIntakePhoto } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { BadRequestError } from "./errors";
import { getIntakeById } from "./aiProductIntakes";
import { aiIntakePhotoStorage as defaultStorage, type AiIntakePhotoStorage } from "./aiIntakePhotoStorage";
import { createAiIntakePhotoRepository } from "../repositories/ai-intake-photo/factory";
import type { AiIntakePhotoRecord, AiIntakePhotoRepository } from "../repositories/ai-intake-photo/types";
import {
  createAiIntakePhotoUseCase,
  deleteAiIntakePhotoUseCase,
  findAiIntakePhotoUseCase,
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
 * Sprint 91 upload sequence (approved): verify intake exists, verify it is
 * Open, validate MIME/size and write the file synchronously (both inside
 * storage.saveIntakePhoto), insert the DB row, and - only if that insert
 * fails - delete the newly-written file before propagating the error. No
 * queue, no outbox, mirroring the try/catch shape already established by
 * services/products.ts's uploadProductPhoto, but fully independent of it.
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
    const row = await createAiIntakePhotoUseCase(repositoryFor(db), {
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
 * Deletion is allowed for a cancelled intake - no status check, only
 * existence/ownership. Required recovery ordering: find the photo, delete
 * the staged file (idempotent - an already-missing file is not an error),
 * and only then delete the database record. If storage deletion fails
 * unexpectedly, the error propagates and the database record is left
 * intact. If the database delete itself then fails, the record is also
 * left intact - a repeated request can complete successfully, since the
 * storage delete is safely repeatable against an already-missing file.
 */
export async function deleteIntakePhoto(
  db: DbClient,
  intakeId: string,
  photoId: string,
  storage: AiIntakePhotoStorage = defaultStorage,
): Promise<void> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing
  const repository = repositoryFor(db);
  const existing = await findAiIntakePhotoUseCase(repository, intakeId, photoId);
  await storage.deleteIntakePhoto(existing.storageKey as string);
  await deleteAiIntakePhotoUseCase(repository, photoId);
}
