import { z } from "zod";

export const createOfferSchema = z.object({
  productId: z.string().min(1, "Product is required"),
  customerName: z.string().min(1, "Name is required"),
  customerEmail: z.string().email("A valid email is required"),
  offeredAmount: z.number().positive("Offer amount must be greater than 0"),
  currency: z.literal("EUR", { message: "Only EUR is currently supported" }),
  message: z.string().optional(),
});

export type CreateOfferInput = z.infer<typeof createOfferSchema>;
