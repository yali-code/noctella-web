import { StockMovementType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { createStockMovementRepositoryBundleForDb } from "../repositories/stock/factory";
import { SqliteUnitOfWork } from "./unitOfWork";
import { enqueueProductStockSync } from "./stockSync";
import type { ManualStockAdjustmentInput, StockMovementListQuery } from "../validation/stockMovement";
import { createManualStockAdjustmentUseCase, getStockBalanceUseCase, getStockHistoryUseCase } from "../use-cases/stock/useCases";
import { applyStockMovementCompatibilitySync, type CompatibleStockMovementInput } from "./stockMovementCompatibility";
export async function listStockMovements(db: DbClient, query: StockMovementListQuery) { const repositories=createStockMovementRepositoryBundleForDb(db); return getStockHistoryUseCase({ unitOfWork: new SqliteUnitOfWork(db), repositories }, query); }
export async function getCurrentStockBalance(db: DbClient, productId: string) { const repositories=createStockMovementRepositoryBundleForDb(db); return getStockBalanceUseCase({ unitOfWork: new SqliteUnitOfWork(db), repositories }, productId); }
export async function createManualStockAdjustment(db: DbClient, input: ManualStockAdjustmentInput) { const repositories=createStockMovementRepositoryBundleForDb(db); const movement=await createManualStockAdjustmentUseCase({ unitOfWork: new SqliteUnitOfWork(db), repositories }, input); await enqueueProductStockSync(db, movement.productId, movement.idempotencyKey ?? movement.id); return movement; }
export async function applyStockMovement(db: DbClient, input: ManualStockAdjustmentInput & { type?: StockMovementType; orderId?: string; orderItemId?: string }) { return createManualStockAdjustment(db, { productId: input.productId, quantityDelta: input.quantityDelta, note: input.note, createdByAdminUserId: input.createdByAdminUserId, idempotencyKey: input.idempotencyKey }); }
/** @deprecated Temporary compatibility export. Use Stock use cases for new code. */
export function applyStockMovementSync(db: unknown, input: CompatibleStockMovementInput) { return applyStockMovementCompatibilitySync(db, input); }
export { StockMovementType };
