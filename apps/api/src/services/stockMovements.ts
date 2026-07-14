import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { ProductStatus, StockMovementType, type StockMovement } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { products, stockMovements } from "../db/schema";
import { enqueueProductStockSync } from "./stockSync";
import { BadRequestError, NotFoundError } from "./errors";
import type { ManualStockAdjustmentInput, StockMovementListQuery } from "../validation/stockMovement";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type StockDb = DbClient | Tx;

type StockMovementRow = typeof stockMovements.$inferSelect;

function toStockMovement(row: StockMovementRow): StockMovement {
  return {
    id: row.id,
    productId: row.productId,
    type: row.type as StockMovementType,
    quantityDelta: row.quantityDelta,
    stockBefore: row.stockBefore,
    stockAfter: row.stockAfter,
    orderId: row.orderId ?? undefined,
    orderItemId: row.orderItemId ?? undefined,
    note: row.note ?? undefined,
    createdByAdminUserId: row.createdByAdminUserId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listStockMovements(db: DbClient, query: StockMovementListQuery) {
  const filters = [];
  if (query.productId) filters.push(eq(stockMovements.productId, query.productId));
  if (query.type) filters.push(eq(stockMovements.type, query.type));
  const where = filters.length ? and(...filters) : undefined;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(stockMovements).where(where);
  const rows = await db
    .select()
    .from(stockMovements)
    .where(where)
    .orderBy(desc(stockMovements.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    items: rows.map(toStockMovement),
    total: count,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function applyStockMovementSync(
  db: StockDb,
  input: {
    productId: string;
    type: StockMovementType;
    quantityDelta: number;
    orderId?: string;
    orderItemId?: string;
    note?: string;
    createdByAdminUserId?: string;
    idempotencyKey?: string;
  },
): StockMovement {
  if (input.idempotencyKey) {
    const [existing] = db.select().from(stockMovements).where(eq(stockMovements.idempotencyKey, input.idempotencyKey)).all();
    if (existing) return toStockMovement(existing);
  }

  const [product] = db.select().from(products).where(eq(products.id, input.productId)).all();
  if (!product) throw new NotFoundError("Product not found");

  const stockBefore = product.stockQuantity;
  const stockAfter = stockBefore + input.quantityDelta;
  if (stockAfter < 0) throw new BadRequestError("Insufficient stock for movement");

  const now = new Date().toISOString();
  const [updated] = db
    .update(products)
    .set({
      stockQuantity: stockAfter,
      status: stockAfter === 0 && input.type === StockMovementType.Sale ? ProductStatus.Sold : product.status,
      updatedAt: now,
    })
    .where(eq(products.id, input.productId))
    .returning()
    .all();
  if (!updated) throw new NotFoundError("Product not found");

  const movement = {
    id: randomUUID(),
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    stockBefore,
    stockAfter,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    note: input.note,
    createdByAdminUserId: input.createdByAdminUserId,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(stockMovements).values(movement).run();
  return movement;
}

export async function applyStockMovement(db: StockDb, input: Parameters<typeof applyStockMovementSync>[1]): Promise<StockMovement> {
  return applyStockMovementSync(db, input);
}

export async function createManualStockAdjustment(db: DbClient, input: ManualStockAdjustmentInput): Promise<StockMovement> {
  const movement = db.transaction((tx) =>
    applyStockMovementSync(tx, {
      ...input,
      type: StockMovementType.ManualAdjustment,
      idempotencyKey: input.idempotencyKey ?? `manual:${input.productId}:${input.quantityDelta}:${input.note ?? ""}:${Date.now()}`,
    }),
  );
  await enqueueProductStockSync(db, movement.productId, movement.idempotencyKey ?? movement.id);
  return movement;
}
