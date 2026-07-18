import type { SalesCompletionCommitInput, SalesCompletionCommitResult } from "../../application/sales/completionCoordination";
export interface SalesCompletionTransactionRepository { commit(input: SalesCompletionCommitInput): SalesCompletionCommitResult | Promise<SalesCompletionCommitResult>; }
