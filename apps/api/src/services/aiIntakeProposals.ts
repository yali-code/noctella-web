import { AiIntakeFieldDecision, AiProductIntakeStatus, type AiIntakeProposalReview, type AiIntakeReviewedField } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { BadRequestError } from "./errors";
import { getIntakeById } from "./aiProductIntakes";
import { listIntakePhotos } from "./aiIntakePhotos";
import { computePhotoSetFingerprint } from "../ai-intake/photoSetFingerprint";
import { createAiIntakeProposalRepository } from "../repositories/ai-intake-proposal/factory";
import type { AiIntakeProposalField, AiIntakeProposalRecord, AiIntakeProposalRepository } from "../repositories/ai-intake-proposal/types";
import { getCurrentProposalUseCase, updateFieldReviewUseCase } from "../use-cases/ai-intake-proposal/useCases";

/** Mirrors services/aiIntakeGeneration.ts's / services/aiProductIntakes.ts's repositoryFor driver-resolution pattern. */
function repositoryFor(db: DbClient): AiIntakeProposalRepository {
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  return createAiIntakeProposalRepository(driver, db);
}

const CONFIRMED_DECISIONS: ReadonlySet<string> = new Set([AiIntakeFieldDecision.Accepted, AiIntakeFieldDecision.Edited]);

/**
 * Sprint 93 correction pass: runtime-safe normalization for values whose
 * declared TypeScript type does not match what the PostgreSQL driver
 * actually returns. `timestamp` columns (no `mode: "string"`) return real
 * Date instances under Postgres; `numeric` columns (no `mode: "number"`)
 * return strings, to avoid float precision loss. SQLite returns plain
 * strings/numbers for the equivalent columns either way, so these helpers
 * are no-ops there and only change behavior under Postgres.
 */
function toIsoString(value: string | number | boolean | Date | null): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function toOptionalIsoString(value: string | number | boolean | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
function toOptionalNumber(value: string | number | boolean | Date | null): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toReviewedField<T>(
  row: AiIntakeProposalRecord,
  prefix: "title" | "description" | "keywords",
  suggestion: T | null,
  parseValue: (raw: string) => T,
): AiIntakeReviewedField<T> {
  const decision = row[`${prefix}Decision`] as AiIntakeFieldDecision;
  const rawValue = row[`${prefix}Value`] as string | null;
  const value = CONFIRMED_DECISIONS.has(decision) && rawValue !== null ? parseValue(rawValue) : null;
  return {
    suggestion,
    decision,
    value,
    reviewedByAdminUserId: (row[`${prefix}ReviewedByAdminUserId`] as string | null) ?? null,
    reviewedAt: toOptionalIsoString(row[`${prefix}ReviewedAt`] as string | Date | null),
  };
}

/**
 * Sprint 93: shared row-to-response mapper, used by both this file (GET
 * proposal, PATCH field review) and services/aiIntakeGeneration.ts (POST
 * generate) - both endpoints return the identical AiIntakeProposalReview
 * shape.
 */
export function toProposalReview(row: AiIntakeProposalRecord, stale: boolean): AiIntakeProposalReview {
  const identity = (v: string) => v;
  return {
    id: row.id as string,
    intakeId: row.intakeId as string,
    title: toReviewedField<string>(row, "title", (row.suggestedTitle as string | null) ?? null, identity),
    description: toReviewedField<string>(row, "description", (row.suggestedDescription as string | null) ?? null, identity),
    keywords: toReviewedField<string[]>(
      row,
      "keywords",
      row.suggestedKeywords ? (JSON.parse(row.suggestedKeywords as string) as string[]) : null,
      (raw) => JSON.parse(raw) as string[],
    ),
    confidenceScore: toOptionalNumber(row.confidenceScore),
    providerName: row.providerName as string,
    promptVersion: row.promptVersion as string,
    generatedAt: toIsoString(row.generatedAt as string | Date),
    createdAt: toIsoString(row.createdAt as string | Date),
    updatedAt: toIsoString(row.updatedAt as string | Date),
    stale,
  };
}

/** Reads remain allowed for a cancelled intake (audit/debug) - no status check here. */
export async function getCurrentProposal(db: DbClient, intakeId: string): Promise<AiIntakeProposalReview> {
  await getIntakeById(db, intakeId); // throws NotFoundError if missing
  const photos = await listIntakePhotos(db, intakeId);
  const { row, stale } = await getCurrentProposalUseCase(repositoryFor(db), intakeId, photos);
  return toProposalReview(row, stale);
}

/**
 * Actor identity (`actorId`) must come only from req.adminUser.id - the
 * route never accepts a reviewer id from the request body.
 */
export async function updateProposalFieldReview(
  db: DbClient,
  intakeId: string,
  field: AiIntakeProposalField,
  decision: AiIntakeFieldDecision,
  editedValue: string | string[] | undefined,
  actorId: string,
  expectedUpdatedAt: string,
): Promise<AiIntakeProposalReview> {
  const intake = await getIntakeById(db, intakeId); // throws NotFoundError if missing
  if (intake.status !== AiProductIntakeStatus.Open) {
    throw new BadRequestError(`Only an Open intake can have its proposal reviewed (current status: "${intake.status}")`);
  }

  const photos = await listIntakePhotos(db, intakeId);
  const editedValueSerialized =
    decision === AiIntakeFieldDecision.Edited ? (field === "keywords" ? JSON.stringify(editedValue) : (editedValue as string)) : undefined;

  const row = await updateFieldReviewUseCase(repositoryFor(db), { intakeId, field, decision, editedValueSerialized, actorId, photos, expectedUpdatedAt });
  const stale = computePhotoSetFingerprint(photos) !== row.photoSetFingerprint;
  return toProposalReview(row, stale);
}
