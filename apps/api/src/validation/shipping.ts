import { PRODUCT_SHIPPING_PROFILE_VALUES, SHIPPING_RULE_TYPE_VALUES } from "@noctella/shared";
import { z } from "zod";

/** Sprint 134: shared with validation/order.ts's addressSchema.countryCode - normalized uppercase, two-letter ISO code. */
export const countryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "countryCode must be a two-letter ISO code")
  .transform((v) => v.toUpperCase());

export const createShippingMethodSchema = z
  .object({
    label: z.string().trim().min(1),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    ruleType: z.enum(SHIPPING_RULE_TYPE_VALUES as [string, ...string[]]),
    flatAmountEurCents: z.number().int().min(0).optional(),
    freeThresholdEurCents: z.number().int().min(0).optional(),
    countryCodes: z.array(countryCodeSchema).optional(),
    shippingProfiles: z.array(z.enum(PRODUCT_SHIPPING_PROFILE_VALUES as [string, ...string[]])).optional(),
  })
  .strict();

export const updateShippingMethodSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    ruleType: z.enum(SHIPPING_RULE_TYPE_VALUES as [string, ...string[]]).optional(),
    flatAmountEurCents: z.number().int().min(0).nullable().optional(),
    freeThresholdEurCents: z.number().int().min(0).nullable().optional(),
    countryCodes: z.array(countryCodeSchema).nullable().optional(),
    shippingProfiles: z.array(z.enum(PRODUCT_SHIPPING_PROFILE_VALUES as [string, ...string[]])).nullable().optional(),
  })
  .strict();

/** Sprint 134: public, non-mutating shipping-options quote - minimum required to resolve authoritative eligible methods/amounts before final COD submission. */
export const shippingQuoteRequestSchema = z
  .object({
    items: z.array(z.object({ productId: z.string().min(1), quantity: z.literal(1).default(1) }).strict()).min(1),
    countryCode: countryCodeSchema.optional(),
  })
  .strict();

export type CreateShippingMethodInput = z.infer<typeof createShippingMethodSchema>;
export type UpdateShippingMethodInput = z.infer<typeof updateShippingMethodSchema>;
export type ShippingQuoteRequest = z.infer<typeof shippingQuoteRequestSchema>;
