import { randomUUID } from "node:crypto";
import { AiIntakeFieldDecision, type AiIntakePhoto, type AiProductIntake } from "@noctella/shared";
import {
  AiIntakeProposalIntakeNotOpenError,
  AiIntakeProposalReviewResetRequiredError,
  AiIntakeProposalStaleError,
  AiIntakeProposalSuggestionUnavailableError,
  AiIntakeProposalVersionConflictError,
  NotFoundError,
} from "../../services/errors";
import { buildAiIntakeGenerationContext } from "../../ai-intake/context";
import { computePhotoSetFingerprint } from "../../ai-intake/photoSetFingerprint";
import { DeterministicAiIntakePromptBuilder } from "../../ai-intake/promptBuilder";
import type { AiIntakeGenerationProvider, AiIntakePhotoReader, AiIntakePromptBuilder } from "../../ai-intake/types";
import { normalizeKeywords } from "../../validation/aiIntakeProposal";
import type {
  AiIntakeProposalConflict,
  AiIntakeProposalField,
  AiIntakeProposalFieldReviewDecision,
  AiIntakeProposalRecord,
  AiIntakeProposalRepository,
  AiIntakeProposalWriteResult,
} from "../../repositories/ai-intake-proposal/types";

const PENDING = "pending";

/**
 * Local monotonic-timestamp helper - deliberately not imported from
 * use-cases/product-write/useCases.ts's private nextUpdatedAt (that function
 * is not exported, and exporting it would mean modifying a file outside
 * Sprint 93's approved change list for a five-line utility). Accepts
 * `string | Date` - Sprint 93 Exact Review CRITICAL correction: PostgreSQL's
 * `timestamp` columns (no `mode: "string"`) return real Date instances at
 * runtime despite AiIntakeProposalRecord's compile-time typing, and
 * Date.parse(aDateInstance) silently truncates sub-second precision (the
 * same bug class use-cases/product-write/useCases.ts's nextUpdatedAt was
 * already fixed for). Identical algorithm/convention otherwise: a successful
 * write always advances updatedAt, even within the same clock-resolution tick.
 */
export function nextUpdatedAt(currentUpdatedAt: string | Date): string {
  const nowMs = Date.now();
  const currentMs = currentUpdatedAt instanceof Date ? currentUpdatedAt.getTime() : Date.parse(currentUpdatedAt);
  if (Number.isNaN(currentMs)) return new Date(nowMs).toISOString();
  return new Date(Math.max(nowMs, currentMs + 1)).toISOString();
}

function allFieldsPending(row: AiIntakeProposalRecord): boolean {
  return row.titleDecision === PENDING && row.descriptionDecision === PENDING && row.keywordsDecision === PENDING;
}

function translateConflict(conflict: AiIntakeProposalConflict | undefined): never {
  switch (conflict?.reason) {
    case "intake_not_found":
      throw new NotFoundError(conflict.message);
    case "intake_not_open":
      throw new AiIntakeProposalIntakeNotOpenError();
    case "review_not_pending":
      throw new AiIntakeProposalReviewResetRequiredError();
    case "photo_context_changed":
      throw new AiIntakeProposalStaleError(conflict.message);
    case "proposal_already_exists":
    case "version_mismatch":
    default:
      throw new AiIntakeProposalVersionConflictError();
  }
}

export interface GenerateOrRegenerateProposalInput {
  intake: AiProductIntake;
  photos: AiIntakePhoto[];
}

/**
 * Sprint 93 correction pass: provider execution stays outside any database
 * transaction. After the provider returns, persistence locks the intake row
 * (see repositories/ai-intake-proposal/drizzle.ts /
 * services/aiIntakeLockTransactionCapabilityForDb.ts), re-validates intake
 * status AND the photo-set fingerprint from data read inside that same lock
 * (rejecting with AiIntakeProposalStaleError if the staged photos changed
 * while the provider was running), and only then writes - closing the
 * unlocked read-then-insert race the Sprint 93 Exact Review classified
 * CRITICAL. Regeneration is rejected (AiIntakeProposalReviewResetRequiredError)
 * before ever calling the provider if any field is not Pending.
 */
export async function generateOrRegenerateProposalUseCase(
  repository: AiIntakeProposalRepository,
  provider: AiIntakeGenerationProvider,
  input: GenerateOrRegenerateProposalInput,
  photoReader: AiIntakePhotoReader,
  promptBuilder: AiIntakePromptBuilder = new DeterministicAiIntakePromptBuilder(),
): Promise<AiIntakeProposalRecord> {
  const existing = await repository.findByIntakeId(input.intake.id);
  if (existing && !allFieldsPending(existing)) {
    throw new AiIntakeProposalReviewResetRequiredError();
  }

  const fingerprint = computePhotoSetFingerprint(input.photos);
  const context = buildAiIntakeGenerationContext(input.intake, input.photos);
  const prompt = promptBuilder.build(context);
  const result = await provider.generate({ context, prompt, photoReader });

  const now = new Date().toISOString();
  const suggestedKeywords = result.proposal.suggestedKeywords ? JSON.stringify(result.proposal.suggestedKeywords) : null;

  const writeResult: AiIntakeProposalWriteResult = existing
    ? await repository.refreshPendingFields({
        id: existing.id as string,
        intakeId: input.intake.id,
        expectedUpdatedAt: String(existing.updatedAt),
        expectedPhotoFingerprint: fingerprint,
        suggestedTitle: result.proposal.suggestedTitle ?? null,
        suggestedDescription: result.proposal.suggestedDescription ?? null,
        suggestedKeywords,
        confidenceScore: result.proposal.confidenceScore ?? null,
        generatedAt: now,
        providerName: result.metadata.providerName,
        promptVersion: result.metadata.promptVersion,
        updatedAt: nextUpdatedAt(existing.updatedAt as string | Date),
      })
    : await repository.insertIfAbsentAndIntakeOpen({
        id: randomUUID(),
        intakeId: input.intake.id,
        expectedPhotoFingerprint: fingerprint,
        suggestedTitle: result.proposal.suggestedTitle ?? null,
        suggestedDescription: result.proposal.suggestedDescription ?? null,
        suggestedKeywords,
        confidenceScore: result.proposal.confidenceScore ?? null,
        generatedAt: now,
        providerName: result.metadata.providerName,
        promptVersion: result.metadata.promptVersion,
        createdAt: now,
        updatedAt: now,
      });

  if (!writeResult.updated) translateConflict(writeResult.conflict);
  return writeResult.row!;
}

export interface GetCurrentProposalResult {
  row: AiIntakeProposalRecord;
  stale: boolean;
}

export async function getCurrentProposalUseCase(
  repository: AiIntakeProposalRepository,
  intakeId: string,
  photos: AiIntakePhoto[],
): Promise<GetCurrentProposalResult> {
  const row = await repository.findByIntakeId(intakeId);
  if (!row) throw new NotFoundError("AI intake proposal not found");
  const currentFingerprint = computePhotoSetFingerprint(photos);
  return { row, stale: currentFingerprint !== row.photoSetFingerprint };
}

const SUGGESTED_COLUMN: Record<AiIntakeProposalField, string> = {
  title: "suggestedTitle",
  description: "suggestedDescription",
  keywords: "suggestedKeywords",
};

export interface UpdateFieldReviewInput {
  intakeId: string;
  field: AiIntakeProposalField;
  decision: AiIntakeFieldDecision;
  /** Pre-serialized (JSON string for keywords) - required and only meaningful when decision is Edited. */
  editedValueSerialized?: string;
  actorId: string;
  /** Used only for a fast, non-authoritative pre-check - see below. */
  photos: AiIntakePhoto[];
  /** Client-supplied optimistic-concurrency token - must match the row's current updatedAt exactly. */
  expectedUpdatedAt: string;
}

/**
 * Sprint 93 correction pass: computes the Accepted value from a freshly-read
 * row (never a value fetched before the atomic transaction), and rejects
 * Accepted outright - throwing AiIntakeProposalSuggestionUnavailableError,
 * no write performed - when the corresponding suggestion is absent, empty,
 * or (for keywords) normalizes to zero entries. Title/description Accepted
 * values are trimmed; keyword Accepted values are normalized with the same
 * trim/dedupe rules Edited keywords already use, so an Accepted value is
 * never a byte-for-byte copy of unnormalized AI output.
 */
function decideFieldReview(existing: AiIntakeProposalRecord, input: UpdateFieldReviewInput): AiIntakeProposalFieldReviewDecision {
  const now = new Date().toISOString();
  const updatedAt = nextUpdatedAt(existing.updatedAt as string | Date);
  let value: string | null;
  let reviewedByAdminUserId: string | null;
  let reviewedAt: string | null;

  if (input.decision === AiIntakeFieldDecision.Pending) {
    value = null;
    reviewedByAdminUserId = null;
    reviewedAt = null;
  } else if (input.decision === AiIntakeFieldDecision.Accepted) {
    const rawSuggestion = existing[SUGGESTED_COLUMN[input.field]] as string | null;
    if (input.field === "keywords") {
      const parsed = rawSuggestion ? (JSON.parse(rawSuggestion) as string[]) : null;
      const normalized = parsed ? normalizeKeywords(parsed) : [];
      if (normalized.length === 0) throw new AiIntakeProposalSuggestionUnavailableError();
      value = JSON.stringify(normalized);
    } else {
      const trimmed = rawSuggestion?.trim() ?? "";
      if (!trimmed) throw new AiIntakeProposalSuggestionUnavailableError();
      value = trimmed;
    }
    reviewedByAdminUserId = input.actorId;
    reviewedAt = now;
  } else if (input.decision === AiIntakeFieldDecision.Edited) {
    value = input.editedValueSerialized ?? null;
    reviewedByAdminUserId = input.actorId;
    reviewedAt = now;
  } else {
    // Rejected - suggestion column is untouched by this write.
    value = null;
    reviewedByAdminUserId = input.actorId;
    reviewedAt = now;
  }

  return { decision: input.decision, value, reviewedByAdminUserId, reviewedAt, updatedAt };
}

/**
 * Sprint 93 correction pass: the staleness check against the intake's
 * current staged photos and the field-review write now happen inside one
 * locked transaction (repository.updateFieldReviewAtomic), closing the
 * service-only-pre-check TOCTOU the Sprint 93 Exact Review classified HIGH.
 * The fingerprint check below, using `input.photos`, is a fast, optional
 * pre-check only - it can produce a false "not stale" if a photo changes
 * immediately afterward, but the atomic repository call re-verifies the
 * fingerprint from a fresh read taken under the intake lock and is always
 * authoritative.
 */
export async function updateFieldReviewUseCase(repository: AiIntakeProposalRepository, input: UpdateFieldReviewInput): Promise<AiIntakeProposalRecord> {
  const existing = await repository.findByIntakeId(input.intakeId);
  if (!existing) throw new NotFoundError("AI intake proposal not found");

  const currentFingerprint = computePhotoSetFingerprint(input.photos);
  if (currentFingerprint !== existing.photoSetFingerprint) {
    throw new AiIntakeProposalStaleError();
  }

  const writeResult = await repository.updateFieldReviewAtomic(input.intakeId, existing.id as string, input.field, input.expectedUpdatedAt, (freshExisting) =>
    decideFieldReview(freshExisting, input),
  );

  if (!writeResult.updated) translateConflict(writeResult.conflict);
  return writeResult.row!;
}
