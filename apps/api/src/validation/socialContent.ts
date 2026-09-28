import { z } from "zod";
import { SOCIAL_CONTENT_STATUSES, SOCIAL_CONTENT_TYPES } from "@noctella/shared";

export const socialId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hashtag = z.string().transform((value) => value.trim().normalize("NFC").replace(/^#/, "").toLowerCase().normalize("NFC"))
  .pipe(z.string().min(1).max(50).regex(/^[\p{L}\p{N}_]+$/u));
export const socialHashtagsSchema = z.array(hashtag).max(10).transform((values) => [...new Set(values)]);
export const socialGeneratedResultSchema = z.object({
  caption: z.string().max(2200).refine((value) => !!value.trim(), "Generated caption is required"),
  hashtags: z.array(z.unknown()).max(5).pipe(socialHashtagsSchema),
  concept: z.string().trim().min(1).max(1000),
  media: z.array(z.object({ photoId: socialId, editorialAltText: z.string().trim().min(1).max(1000) }).strict()).min(1).max(10)
    .refine((items) => new Set(items.map((item) => item.photoId)).size === items.length, "Duplicate media IDs"),
}).strict();
const editorialAltTexts = z.array(z.object({ photoId: socialId, editorialAltText: z.string().max(1000) }).strict()).max(10)
  .refine((items) => new Set(items.map((item) => item.photoId)).size === items.length, "Duplicate editorial alt-text photo IDs");
export const socialDraftSchema = z.object({
  platform: z.literal("instagram").optional(),
  accountLabel: z.literal("vault").optional(),
  contentType: z.enum(SOCIAL_CONTENT_TYPES).default("post"),
  caption: z.string().max(2200).default(""),
  productId: socialId.nullable().default(null),
  mediaIds: z.array(socialId).max(10).refine((ids) => new Set(ids).size === ids.length, "Duplicate media IDs").default([]),
  hashtags: socialHashtagsSchema.optional(),
  concept: z.string().max(1000).nullable().optional(),
  mediaEditorialAltTexts: editorialAltTexts.optional(),
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
