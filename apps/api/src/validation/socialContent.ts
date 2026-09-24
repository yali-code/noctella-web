import { z } from "zod";
import { SOCIAL_CONTENT_STATUSES, SOCIAL_CONTENT_TYPES } from "@noctella/shared";

export const socialId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const socialDraftSchema = z.object({
  platform: z.literal("instagram").optional(),
  accountLabel: z.literal("vault").optional(),
  contentType: z.enum(SOCIAL_CONTENT_TYPES).default("post"),
  caption: z.string().max(2200).default(""),
  productId: socialId.nullable().default(null),
  mediaIds: z.array(socialId).max(10).refine((ids) => new Set(ids).size === ids.length, "Duplicate media IDs").default([]),
}).strict();
export const socialEditSchema = socialDraftSchema.extend({ expectedVersion: z.number().int().positive() });
export const socialTransitionSchema = z.object({
  status: z.enum(SOCIAL_CONTENT_STATUSES),
  expectedVersion: z.number().int().positive(),
}).strict();
export const socialListSchema = z.object({
  status: z.enum(SOCIAL_CONTENT_STATUSES).optional(),
  contentType: z.enum(SOCIAL_CONTENT_TYPES).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type SocialDraft = z.infer<typeof socialDraftSchema>;
