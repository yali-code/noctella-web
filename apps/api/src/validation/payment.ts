import { z } from "zod";
import { PAYMENT_PROVIDER_VALUES, PAYMENT_STATUS_VALUES } from "@noctella/shared";

export const initializePaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  orderDraftId: z.string().min(1, "Order draft is required"),
  amount: z.number().positive("Amount must be greater than 0"),
  currency: z.literal("EUR", { message: "Only EUR is currently supported" }),
});
export const checkoutAddressSchema=z.object({fullName:z.string().min(1),line1:z.string().min(1),line2:z.string().optional(),city:z.string().min(1),region:z.string().optional(),postalCode:z.string().min(1),country:z.string().min(1),phone:z.string().optional()}).strict();
export const stripeCheckoutIntentSchema=z.object({version:z.literal(1),orderDraftId:z.string().min(1),guestEmail:z.string().email(),billingAddress:checkoutAddressSchema,shippingAddress:checkoutAddressSchema,notes:z.string().optional(),items:z.array(z.object({productId:z.string().min(1),quantity:z.literal(1)}).strict()).min(1)}).strict();
export const initializeStripeCheckoutSchema=stripeCheckoutIntentSchema.omit({version:true}).extend({provider:z.literal("stripe")}).strict();

export const verifyPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  providerReference: z.string().min(1, "Provider reference is required"),
});

export const cancelPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  providerReference: z.string().min(1, "Provider reference is required"),
});

export const listPaymentsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUS_VALUES as [string, ...string[]]).optional(),
  provider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]).optional(),
});
