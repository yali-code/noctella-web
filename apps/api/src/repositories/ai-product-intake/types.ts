export type AiProductIntakeRecord = Record<string, string | number | boolean | null>;

export interface AiProductIntakeCreateInput {
  id: string;
  createdByAdminUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiProductIntakeListQuery {
  page: number;
  pageSize: number;
  status?: string;
}

export interface AiProductIntakeCancelConflict {
  field: "id" | "status";
  message: string;
}

export interface AiProductIntakeCancelResult {
  updated: boolean;
  row?: AiProductIntakeRecord;
  conflict?: AiProductIntakeCancelConflict;
}

export interface AiProductIntakeCancelInput {
  id: string;
  expectedStatus: string;
  cancelledByAdminUserId: string;
  cancelledAt: string;
  cancellationReason?: string;
  updatedAt: string;
}

/**
 * Sprint 90: repository for the ai_product_intakes foundation table only.
 * All four Sprint 90 operations are single-statement, so no transaction
 * capability is needed - each method runs directly against the passed-in
 * db/tx handle, matching how apps/api/src/services/aiDrafts.ts's non-approval
 * functions (getDraftById, listDrafts, updateDraft, rejectDraft) already
 * operate directly against DbClient without a dedicated transaction wrapper.
 */
export interface AiProductIntakeRepository {
  create(input: AiProductIntakeCreateInput): Promise<AiProductIntakeRecord>;
  findById(id: string): Promise<AiProductIntakeRecord | null>;
  list(query: AiProductIntakeListQuery): Promise<AiProductIntakeRecord[]>;
  count(query: AiProductIntakeListQuery): Promise<number>;
  /**
   * Atomic conditional transition: UPDATE ... WHERE id = ? AND status = ?.
   * Zero affected rows means either not-found or already non-matching
   * status - conflict.field distinguishes the two so the use case can treat
   * "already Cancelled" as idempotent success rather than an error.
   */
  cancelWithExpectedState(input: AiProductIntakeCancelInput): Promise<AiProductIntakeCancelResult>;
}
