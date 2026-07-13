import { PRICE_CURRENCY_VALUES, PriceCurrency, STOCK_MOVEMENT_TYPE_VALUES, StockMovementType } from "@noctella/shared";
import { z } from "zod";

export const createStockMovementSchema = z
  .object({
    productId: z.string().min(1),
    type: z.enum(STOCK_MOVEMENT_TYPE_VALUES as [StockMovementType, ...StockMovementType[]]),
    quantity: z.number().int().positive(),
    newStock: z.number().int().min(0).optional(),
    unitCost: z.number().min(0).optional(),
    currency: z.enum(PRICE_CURRENCY_VALUES as [PriceCurrency, ...PriceCurrency[]]).default(PriceCurrency.Eur),
    referenceType: z.string().min(1).optional(),
    referenceId: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === StockMovementType.Correction && data.newStock === undefined) {
      ctx.addIssue({ code: "custom", path: ["newStock"], message: "newStock is required for corrections" });
    }
  });

export const stockMovementListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(STOCK_MOVEMENT_TYPE_VALUES as [StockMovementType, ...StockMovementType[]]).optional(),
  productId: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
});

export type CreateStockMovementInput = z.infer<typeof createStockMovementSchema>;
export type StockMovementListQuery = z.infer<typeof stockMovementListQuerySchema>;
