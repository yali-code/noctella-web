import type { SalesCompletionCommitInput } from "./completionCoordination";

export interface CompleteSaleInput extends SalesCompletionCommitInput {}
export interface CompleteSaleResult { readonly saleId: string; readonly status: "Completed"; readonly completedAt: string; readonly grossRevenue: number; readonly netRevenue: number; readonly itemCost: number; readonly profit: number; readonly financialSnapshotId: string; readonly financeEntryId: string; readonly completionHistoryId: string | null; readonly replayed: boolean }
