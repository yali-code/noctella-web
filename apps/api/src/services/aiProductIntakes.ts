import type { AiProductIntake, AiProductIntakeStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { createAiProductIntakeRepository } from "../repositories/ai-product-intake/factory";
import type { AiProductIntakeRecord, AiProductIntakeRepository } from "../repositories/ai-product-intake/types";
import {
  cancelAiProductIntakeUseCase,
  createAiProductIntakeUseCase,
  getAiProductIntakeUseCase,
  listAiProductIntakesUseCase,
} from "../use-cases/ai-product-intake/useCases";
import type { AiProductIntakeListQuery } from "../validation/aiProductIntake";

function toIntake(row: AiProductIntakeRecord): AiProductIntake {
  return {
    id: row.id as string,
    status: row.status as AiProductIntakeStatus,
    createdByAdminUserId: row.createdByAdminUserId as string,
    resultProductId: (row.resultProductId as string | null) ?? undefined,
    cancelledAt: (row.cancelledAt as string | null) ?? undefined,
    cancelledByAdminUserId: (row.cancelledByAdminUserId as string | null) ?? undefined,
    cancellationReason: (row.cancellationReason as string | null) ?? undefined,
    appliedAt: toOptionalIsoString(row.appliedAt as string | Date | null),
    appliedByAdminUserId: (row.appliedByAdminUserId as string | null) ?? undefined,
    finalizedAt: toOptionalIsoString(row.finalizedAt as string | Date | null),
    finalizedByAdminUserId: (row.finalizedByAdminUserId as string | null) ?? undefined,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/** Sprint 94: PostgreSQL timestamptz columns return Date instances at runtime - see toReviewedField's identical helper in services/aiIntakeProposals.ts. */
function toOptionalIsoString(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Mirrors services/aiDrafts.ts's approveDraft driver resolution: the passed-in
 * `db` (app singleton in production, an isolated test db in tests) always
 * determines which table object to query; DATABASE_DRIVER only selects which
 * dialect's schema module matches that `db` handle's shape.
 */
function repositoryFor(db: DbClient): AiProductIntakeRepository {
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  return createAiProductIntakeRepository(driver, db);
}

export async function createIntake(db: DbClient, createdByAdminUserId: string): Promise<AiProductIntake> {
  const row = await createAiProductIntakeUseCase(repositoryFor(db), { createdByAdminUserId });
  return toIntake(row);
}

export async function getIntakeById(db: DbClient, id: string): Promise<AiProductIntake> {
  const row = await getAiProductIntakeUseCase(repositoryFor(db), id);
  return toIntake(row);
}

export async function listIntakes(db: DbClient, query: AiProductIntakeListQuery) {
  const result = await listAiProductIntakesUseCase(repositoryFor(db), query);
  return { ...result, items: result.items.map(toIntake) };
}

export async function cancelIntake(
  db: DbClient,
  id: string,
  cancelledByAdminUserId: string,
  cancellationReason?: string,
): Promise<AiProductIntake> {
  const row = await cancelAiProductIntakeUseCase(repositoryFor(db), { id, cancelledByAdminUserId, cancellationReason });
  return toIntake(row);
}
