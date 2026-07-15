import type { StockMovement, StockMovementType } from "@noctella/shared";
export interface StockMovementListQuery { productId?: string; type?: StockMovementType | string; page: number; pageSize: number }
export interface StockBalanceProjection { productId: string; quantity: number }
export interface StockMovementCreateInput { id: string; productId: string; type: StockMovementType; quantityDelta: number; stockBefore: number; stockAfter: number; orderId?: string; orderItemId?: string; note?: string; createdByAdminUserId?: string; idempotencyKey?: string; createdAt: string; updatedAt: string; updateProductStatusOnZeroSale?: boolean }
export interface StockMovementReadRepository { productExists(productId: string): Promise<boolean>; getProductBaseStock(productId: string): Promise<number | undefined>; getBalance(productId: string): Promise<StockBalanceProjection | undefined>; getHistory(query: StockMovementListQuery): Promise<{ items: StockMovement[]; total: number; page: number; pageSize: number }>; findByIdempotencyKey(key: string): Promise<StockMovement | undefined>; }
export interface StockMovementWriteRepository { create(input: StockMovementCreateInput): Promise<StockMovement>; }
export interface StockMovementRepositoryBundle { stockMovements: { read: StockMovementReadRepository; write: StockMovementWriteRepository } }
