import { sql } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import type { ProductAvailabilityProjection } from "../../repositories/product-read/types";

/**
 * ADS-002C.3: conservative READ-ONLY reservation-aware inventory reader.
 * Production source of truth is SQLite; this query NEVER calls expireReservations,
 * writes stock, or expires/reclassifies reservations. Expired-but-still-Active rows
 * remain counted as reserved (safe under-advertising rather than overselling).
 *
 * The caller must still recheck marketplace freshness and stock conflicts before
 * any external ad activation. This is NOT an ad-launch authorization.
 */
export async function readAdsReservationAwareAvailability(
  db: Pick<DbClient, "all">,
  productId: string,
): Promise<ProductAvailabilityProjection | null> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(productId)) return null;
  const rows = await db.all(sql`
    SELECT p.id AS product_id,
           p.stock_quantity AS physical_stock,
           (SELECT COALESCE(SUM(r.quantity), 0)
              FROM stock_reservations r
             WHERE r.product_id = p.id AND r.status = 'Active') AS reserved_stock,
           (SELECT COUNT(*)
              FROM stock_reservations r
             WHERE r.product_id = p.id AND r.status = 'Active'
               AND (r.quantity IS NULL OR r.quantity < 0 OR r.quantity != CAST(r.quantity AS INTEGER))) AS invalid_reservations
      FROM products p
     WHERE p.id = ${productId}
     LIMIT 1
  `);
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row || row.product_id !== productId || row.invalid_reservations !== 0) return null;
  const physicalStock = row.physical_stock;
  const reservedStock = row.reserved_stock;
  if (typeof physicalStock !== "number" || !Number.isSafeInteger(physicalStock)
      || typeof reservedStock !== "number" || !Number.isSafeInteger(reservedStock)
      || physicalStock < 0 || reservedStock < 0 || reservedStock > physicalStock) return null;
  const availableStock = physicalStock - reservedStock;
  return {
    productId, physicalStock, reservedStock, reservedStockSupported: true,
    availableStock, availableQuantity: availableStock,
  };
}
