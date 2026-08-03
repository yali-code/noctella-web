import { randomUUID } from "node:crypto";
import { AiProductIntakeStatus } from "@noctella/shared";
import { BadRequestError, NotFoundError } from "../../services/errors";
import type { AiProductIntakeRepository } from "../../repositories/ai-product-intake/types";

export interface CreateAiProductIntakeInput {
  createdByAdminUserId: string;
}

export async function createAiProductIntakeUseCase(repository: AiProductIntakeRepository, input: CreateAiProductIntakeInput) {
  const now = new Date().toISOString();
  return repository.create({
    id: randomUUID(),
    createdByAdminUserId: input.createdByAdminUserId,
    createdAt: now,
    updatedAt: now,
  });
}

export async function getAiProductIntakeUseCase(repository: AiProductIntakeRepository, id: string) {
  const row = await repository.findById(id);
  if (!row) throw new NotFoundError("AI product intake not found");
  return row;
}

export interface ListAiProductIntakesInput {
  page: number;
  pageSize: number;
  status?: string;
}

export async function listAiProductIntakesUseCase(repository: AiProductIntakeRepository, input: ListAiProductIntakesInput) {
  const [items, total] = await Promise.all([repository.list(input), repository.count(input)]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export interface CancelAiProductIntakeInput {
  id: string;
  cancelledByAdminUserId: string;
  cancellationReason?: string;
}

/**
 * Sprint 90: cancellation is deliberately idempotent - a repeated or
 * concurrently-lost cancel request against an intake that is already
 * Cancelled returns the existing (unmodified) record as success rather than
 * a conflict, so cancelledAt/cancelledByAdminUserId/cancellationReason are
 * never overwritten by a second request. Only two statuses exist in Sprint
 * 90 (Open, Cancelled), so the "already Cancelled" branch below is the only
 * reachable non-update outcome; it is written as an explicit status check
 * (not a blanket "any conflict is idempotent" fallback) so a future terminal
 * status introduced by a later sprint (e.g. Applied) can be rejected instead
 * of incorrectly treated as idempotent, without needing to be added here.
 */
export async function cancelAiProductIntakeUseCase(repository: AiProductIntakeRepository, input: CancelAiProductIntakeInput) {
  const cancelledAt = new Date().toISOString();
  const result = await repository.cancelWithExpectedState({
    id: input.id,
    expectedStatus: AiProductIntakeStatus.Open,
    cancelledByAdminUserId: input.cancelledByAdminUserId,
    cancelledAt,
    cancellationReason: input.cancellationReason,
    updatedAt: cancelledAt,
  });

  if (result.updated) return result.row!;

  if (result.conflict?.field === "id") throw new NotFoundError(result.conflict.message);

  if (result.row?.status === AiProductIntakeStatus.Cancelled) return result.row;

  throw new BadRequestError(result.conflict?.message ?? "AI product intake cannot be cancelled from its current status");
}
