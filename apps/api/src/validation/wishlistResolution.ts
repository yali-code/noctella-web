import { z } from "zod";

export const MAX_PUBLIC_WISHLIST_RESOLUTION_IDS = 100;

export const publicWishlistResolutionSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(MAX_PUBLIC_WISHLIST_RESOLUTION_IDS),
}).strict();

export type PublicWishlistResolutionInput = z.infer<typeof publicWishlistResolutionSchema>;
