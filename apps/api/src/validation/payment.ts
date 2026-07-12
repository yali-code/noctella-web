import { z } from "zod";
import { PAYMENT_PROVIDER_VALUES } from "@noctella/shared";

export const initializePaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  orderDraftId: z.string().min(1, "Order draft is required"),
  amount: z.number().positive("Amount must be greater than 0"),
  currency: z.literal("EUR", { message: "Only EUR is currently supported" }),
});

export const verifyPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  providerReference: z.string().min(1, "Provider reference is required"),
});

export const cancelPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  providerReference: z.string().min(1, "Provider reference is required"),
});
