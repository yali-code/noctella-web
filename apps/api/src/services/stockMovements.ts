import { StockMovementType } from "@noctella/shared";
import type { InventoryApplicationContext } from "./inventoryApplicationContext";
import { createInventoryApplicationContextForDb } from "./inventoryApplicationContextForDb";
import { createDecreaseInventoryUseCase, createGetInventoryUseCase, createIncreaseInventoryUseCase, createListProductsUseCase, createListStockMovementsUseCase, createSetInventoryQuantityUseCase, InsufficientInventoryError, InvalidInventoryQuantityError } from "../application/inventory";
import { enqueueProductStockSync } from "./stockSync";
import { BadRequestError } from "./errors";
import type { ManualStockAdjustmentInput, StockMovementListQuery } from "../validation/stockMovement";
import { applyStockMovementCompatibilitySync, type CompatibleStockMovementInput } from "./stockMovementCompatibility";

type ServiceContext = unknown | InventoryApplicationContext;
function context(input: ServiceContext): InventoryApplicationContext { return (input as InventoryApplicationContext).configuration?.inventoryApplicationContext ? input as InventoryApplicationContext : createInventoryApplicationContextForDb(input as never); }
function db(input: ServiceContext): unknown | null { return (input as InventoryApplicationContext).configuration?.inventoryApplicationContext ? null : input; }
function page<T>(items:T[], query:StockMovementListQuery){ const page=query.page, pageSize=query.pageSize; const start=(page-1)*pageSize; return { items:items.slice(start,start+pageSize), total:items.length, page, pageSize }; }

export async function listStockMovements(dbOrContext: ServiceContext, query: StockMovementListQuery) {
  const ctx=context(dbOrContext);
  const productIds=query.productId?[query.productId]:(await createListProductsUseCase(ctx).execute()).map((p)=>p.id);
  const items=(await Promise.all(productIds.map((productId)=>createListStockMovementsUseCase(ctx).execute({ productId })))).flat();
  return page(query.type?items.filter((m)=>m.type===query.type):items, query);
}
export async function getCurrentStockBalance(dbOrContext: ServiceContext, productId: string) {
  const inv=await createGetInventoryUseCase(context(dbOrContext)).execute({ productId });
  return { productId: inv.productId, quantity: inv.quantity, updatedAt: inv.updatedAt };
}
export async function createManualStockAdjustment(dbOrContext: ServiceContext, input: ManualStockAdjustmentInput) {
  const ctx=context(dbOrContext);
  const current=await createGetInventoryUseCase(ctx).execute({ productId: input.productId });
  try {
    if (input.quantityDelta > 0) await createSetInventoryQuantityUseCase(ctx).execute({ productId: input.productId, quantity: current.quantity + input.quantityDelta, expectedVersion: current.updatedAt, idempotencyKey: input.idempotencyKey, note: input.note ?? "Manual stock adjustment" });
    else await createSetInventoryQuantityUseCase(ctx).execute({ productId: input.productId, quantity: current.quantity + input.quantityDelta, expectedVersion: current.updatedAt, idempotencyKey: input.idempotencyKey, note: input.note ?? "Manual stock adjustment" });
  } catch (error) { if (error instanceof InsufficientInventoryError || error instanceof InvalidInventoryQuantityError) throw new BadRequestError("Insufficient stock for movement"); throw error; }
  const items=await createListStockMovementsUseCase(ctx).execute({ productId: input.productId });
  const movement=items[items.length-1];
  const legacyDb=db(dbOrContext); if (legacyDb) await enqueueProductStockSync(legacyDb as never, movement.productId, movement.idempotencyKey ?? movement.id);
  return movement;
}
export async function applyStockMovement(dbOrContext: ServiceContext, input: ManualStockAdjustmentInput & { type?: StockMovementType; orderId?: string; orderItemId?: string }) {
  if (!input.type || input.type === StockMovementType.ManualAdjustment) return createManualStockAdjustment(dbOrContext, { productId: input.productId, quantityDelta: input.quantityDelta, note: input.note, createdByAdminUserId: input.createdByAdminUserId, idempotencyKey: input.idempotencyKey });
  const ctx=context(dbOrContext);
  const current=await createGetInventoryUseCase(ctx).execute({ productId: input.productId });
  try {
    if (input.quantityDelta < 0) await createDecreaseInventoryUseCase(ctx).execute({ productId: input.productId, quantity: Math.abs(input.quantityDelta), expectedVersion: current.updatedAt, idempotencyKey: input.idempotencyKey, note: input.note, orderId: input.orderId, orderItemId: input.orderItemId });
    else await createIncreaseInventoryUseCase(ctx).execute({ productId: input.productId, quantity: input.quantityDelta, expectedVersion: current.updatedAt, idempotencyKey: input.idempotencyKey, note: input.note, orderId: input.orderId, orderItemId: input.orderItemId });
  } catch (error) { if (error instanceof InsufficientInventoryError || error instanceof InvalidInventoryQuantityError) throw new BadRequestError("Insufficient stock for movement"); throw error; }
  const items=await createListStockMovementsUseCase(ctx).execute({ productId: input.productId });
  const movement=items[items.length-1];
  const legacyDb=db(dbOrContext); if (legacyDb) await enqueueProductStockSync(legacyDb as never, movement.productId, movement.idempotencyKey ?? movement.id);
  return movement;
}
/** @deprecated Temporary compatibility export. Use Stock use cases for new code. */
export function applyStockMovementSync(db: unknown, input: CompatibleStockMovementInput) { return applyStockMovementCompatibilitySync(db, input); }
export { StockMovementType };
