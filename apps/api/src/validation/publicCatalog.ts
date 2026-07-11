import { z } from "zod";

export const publicProductListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  categorySlug: z.string().optional(),
  collectionSlug: z.string().optional(),
  isFeatured: z.coerce.boolean().optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "title_asc"]).default("newest"),
});

export type PublicProductListQuery = z.infer<typeof publicProductListQuerySchema>;
