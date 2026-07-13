import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { PriceCurrency, type StockMovement, StockMovementType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { products, stockMovements } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import type { CreateStockMovementInput, StockMovementListQuery } from "../validation/stockMovement";

function toStockMovement(row: typeof stockMovements.$inferSelect): StockMovement {
  return {
    id: row.id,
    productId: row.productId,
    type: row.type as StockMovementType,
    quantity: row.quantity,
    previousStock: row.previousStock,
    newStock: row.newStock,
    unitCost: row.unitCost ?? undefined,
    currency: (row.currency as PriceCurrency) ?? undefined,
    referenceType: row.referenceType ?? undefined,
    referenceId: row.referenceId ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

function resolveNewStock(input: CreateStockMovementInput, previousStock: number): { quantity: number; newStock: number } {
  switch (input.type) {
    case StockMovementType.Purchase:
    case StockMovementType.ManualIncrease:
    case StockMovementType.ReturnIn:
      return { quantity: input.quantity, newStock: previousStock + input.quantity };
    case StockMovementType.Sale:
    case StockMovementType.ManualDecrease:
    case StockMovementType.ReturnOut: {
      const newStock = previousStock - input.quantity;
      if (newStock < 0) throw new BadRequestError("Stock cannot become negative");
      return { quantity: input.quantity, newStock };
    }
    case StockMovementType.Correction: {
      if (input.newStock === undefined) throw new BadRequestError("newStock is required for corrections");
      const quantity = Math.abs(input.newStock - previousStock);
      if (quantity <= 0) throw new BadRequestError("Correction must change stock");
      return { quantity, newStock: input.newStock };
    }
    default:
      throw new BadRequestError("Unsupported stock movement type");
  }
}

export async function getStockMovementById(db: DbClient, id: string): Promise<StockMovement> {
  const [row] = await db.select().from(stockMovements).where(eq(stockMovements.id, id));
  if (!row) throw new NotFoundError("Stock movement not found");
  return toStockMovement(row);
}

type StockMovementTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export function createStockMovementInTransaction(
  tx: StockMovementTransaction,
  input: CreateStockMovementInput,
  options?: { id?: string; now?: string },
): string {
  const id = options?.id ?? randomUUID();
  const now = options?.now ?? new Date().toISOString();

  const [product] = tx.select().from(products).where(eq(products.id, input.productId)).all();
  if (!product) throw new NotFoundError("Product not found");

  const previousStock = product.stockQuantity;
  const { quantity, newStock } = resolveNewStock(input, previousStock);
  if (newStock < 0) throw new BadRequestError("Stock cannot become negative");

  tx
    .update(products)
    .set({ stockQuantity: newStock, updatedAt: now })
    .where(eq(products.id, input.productId))
    .run();

  tx
    .insert(stockMovements)
    .values({
      id,
      productId: input.productId,
      type: input.type,
      quantity,
      previousStock,
      newStock,
      unitCost: input.unitCost,
      currency: input.currency ?? PriceCurrency.Eur,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note,
      createdAt: now,
    })
    .run();

  return id;
}

export async function createStockMovement(
  db: DbClient,
  input: CreateStockMovementInput,
): Promise<StockMovement> {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    createStockMovementInTransaction(tx, input, { id, now });
  });

  return getStockMovementById(db, id);
}

export async function listStockMovements(db: DbClient, query: StockMovementListQuery) {
  const filters = [];
  if (query.type) filters.push(eq(stockMovements.type, query.type));
  if (query.productId) filters.push(eq(stockMovements.productId, query.productId));
  if (query.referenceType) filters.push(eq(stockMovements.referenceType, query.referenceType));
  if (query.referenceId) filters.push(eq(stockMovements.referenceId, query.referenceId));
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
    data: rows.map(toStockMovement),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count),
      totalPages: Math.ceil(Number(count) / query.pageSize),
    },
  };
}

export function listStockMovementsByProduct(db: DbClient, productId: string, query: StockMovementListQuery) {
  return listStockMovements(db, { ...query, productId });
}
