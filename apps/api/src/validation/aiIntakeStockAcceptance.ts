import { z } from "zod";
import { ProductType } from "@noctella/shared";

/**
 * Sprint 106: the Stock Acceptance request contract. Deliberately excludes
 * `sku` - it is now system-generated (see
 * repositories/product-write/drizzle.ts's allocateNextProductSkuInTransaction)
 * and must never be supplied by the admin or the AI. Every AI-suggested
 * "full product analysis" field (brand/model/manufacturer/countryOfOrigin/
 * period/materials/condition/conditionDescription/seoTitle/metaDescription/
 * priceEur/categoryId) is admin-reviewable/editable before submission - the
 * server never re-derives these from the stored proposal, it trusts exactly
 * what the admin submits here (mirroring how categoryId/type/priceEur/
 * stockQuantity already work in the existing Save as Draft contract).
 * Strict so any unknown field (including a client-supplied sku) is rejected,
 * not silently stripped.
 *
 * Sprint 137: priceEur is now optional - the warehouse must not be required to enter a sales
 * price during Stock Acceptance (see Product.priceEur's own nullable doc comment in
 * @noctella/shared). When the caller does supply a value it must still be a genuine positive
 * EUR amount - never 0 or negative, and this contract never invents/defaults one on the
 * caller's behalf.
 */
export const stockAcceptanceSchema = z
  .object({
    categoryId: z.string().trim().min(1, "categoryId is required"),
    type: z.nativeEnum(ProductType),
    priceEur: z.number().positive("EUR price must be greater than 0").optional(),
    stockQuantity: z.number().int().min(0).optional(),
    brand: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    manufacturer: z.string().trim().min(1).optional(),
    countryOfOrigin: z.string().trim().min(1).optional(),
    period: z.string().trim().min(1).optional(),
    materials: z.string().trim().min(1).optional(),
    condition: z.string().trim().min(1).optional(),
    conditionDescription: z.string().trim().min(1).optional(),
    seoTitle: z.string().trim().min(1).optional(),
    metaDescription: z.string().trim().min(1).optional(),
    expectedProposalUpdatedAt: z.string().min(1, "expectedProposalUpdatedAt is required"),
  })
  .strict();

export type StockAcceptanceInput = z.infer<typeof stockAcceptanceSchema>;
