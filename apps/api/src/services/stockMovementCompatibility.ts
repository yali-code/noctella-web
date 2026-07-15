import { randomUUID } from "node:crypto";
import { StockMovementType, type StockMovement } from "@noctella/shared";
import { createStockMovementRepositoryBundleForDb } from "../repositories/stock/factory";
import type { StockBalanceProjection, StockMovementRepositoryBundle } from "../repositories/stock/types";
import { BadRequestError, NotFoundError } from "./errors";

export interface CompatibleStockMovementInput {
  productId: string;
  type: StockMovementType;
  quantityDelta: number;
  orderId?: string;
  orderItemId?: string;
  note?: string;
  createdByAdminUserId?: string;
  idempotencyKey?: string;
}

type SyncStockRepositoryBundle = {
  stockMovements: {
    read: {
      getBalance(productId: string): StockBalanceProjection | undefined;
      findByIdempotencyKey(key: string): StockMovement | undefined;
    };
    write: {
      create(input: Parameters<StockMovementRepositoryBundle["stockMovements"]["write"]["create"]>[0]): StockMovement;
    };
  };
};

function requireSync<T>(value: T | Promise<T>, operation: string): T {
  if (value && typeof (value as Promise<T>).then === "function") throw new Error(`STOCK_COMPAT_ASYNC_${operation}_REJECTED`);
  return value as T;
}

/**
 * @deprecated Temporary Sprint 28A compatibility adapter for legacy transaction-owned callers.
 * Remove after Sprint 28B+ migrations move legacy domains to Stock use cases.
 * This function must be called with the caller's transaction-scoped DB client; it does not open a transaction or enqueue sync.
 */
export function applyStockMovementCompatibilitySync(db: unknown, input: CompatibleStockMovementInput): StockMovement {
  if (!Number.isInteger(input.quantityDelta)) throw new BadRequestError("Delta must be an integer");
  if (input.quantityDelta === 0) throw new BadRequestError("Delta must not be zero");
  const repositories = createStockMovementRepositoryBundleForDb(db) as unknown as SyncStockRepositoryBundle;
  if (input.idempotencyKey) {
    const existing = requireSync(repositories.stockMovements.read.findByIdempotencyKey(input.idempotencyKey), "IDEMPOTENCY_LOOKUP");
    if (existing) return existing;
  }
  const balance = requireSync(repositories.stockMovements.read.getBalance(input.productId), "BALANCE_LOOKUP");
  if (!balance) throw new NotFoundError("Product not found");
  const stockAfter = balance.quantity + input.quantityDelta;
  if (stockAfter < 0) throw new BadRequestError("Insufficient stock for movement");
  const now = new Date().toISOString();
  return requireSync(repositories.stockMovements.write.create({
    id: randomUUID(),
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    stockBefore: balance.quantity,
    stockAfter,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    note: input.note,
    createdByAdminUserId: input.createdByAdminUserId,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
    updateProductStatusOnZeroSale: input.type === StockMovementType.Sale,
  }), "CREATE");
}
