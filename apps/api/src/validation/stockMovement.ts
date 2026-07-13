import { STOCK_MOVEMENT_TYPE_VALUES } from "@noctella/shared";
import { z } from "zod";


export const stockMovementListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  productId: z.string().min(1).optional(),
  type: z.enum(STOCK_MOVEMENT_TYPE_VALUES as [string, ...string[]]).optional(),
});

export const manualStockAdjustmentSchema = z.object({
  productId: z.string().min(1),
  quantityDelta: z.number().int().refine((value) => value !== 0, "Adjustment cannot be zero"),
  note: z.string().trim().min(1).max(500).optional(),
  createdByAdminUserId: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});

export type StockMovementListQuery = z.infer<typeof stockMovementListQuerySchema>;
export type ManualStockAdjustmentInput = z.infer<typeof manualStockAdjustmentSchema>;
