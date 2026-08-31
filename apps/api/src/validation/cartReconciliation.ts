import { z } from "zod";

export const MAX_PUBLIC_CART_LINES = 20;

export const publicCartReconciliationSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    quantity: z.literal(1),
  }).strict()).min(1).max(MAX_PUBLIC_CART_LINES),
}).strict();

export type PublicCartReconciliationInput = z.infer<typeof publicCartReconciliationSchema>;
