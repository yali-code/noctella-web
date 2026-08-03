import { z } from "zod";
import { AiIntakeFieldDecision } from "@noctella/shared";

/**
 * Sprint 93: trims, drops empty entries, case-insensitively dedupes
 * (preserving the first-seen spelling/order). No canonical length limit
 * exists anywhere in this codebase for title/description/keyword fields
 * (confirmed: apps/api/src/validation/product.ts's generatedTitle-equivalent
 * fields carry none) - per the approved architecture, Sprint 93 does not
 * invent one; existing request-size protections are relied on instead.
 */
export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Actor identity (reviewer) comes only from req.adminUser.id - never from
 * the request body. `value` is required and validated only when `decision`
 * is Edited; supplying it for any other decision is a strict validation
 * error, not silently ignored.
 */
function fieldReviewSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      decision: z.nativeEnum(AiIntakeFieldDecision),
      expectedUpdatedAt: z.string().min(1, "expectedUpdatedAt is required"),
      value: valueSchema.optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.decision === AiIntakeFieldDecision.Edited) {
        if (data.value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is required when decision is edited", path: ["value"] });
        }
      } else if (data.value !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must not be supplied unless decision is edited", path: ["value"] });
      }
    });
}

export const titleFieldReviewSchema = fieldReviewSchema(z.string().trim().min(1, "value must not be empty"));
export const descriptionFieldReviewSchema = fieldReviewSchema(z.string().trim().min(1, "value must not be empty"));
export const keywordsFieldReviewSchema = fieldReviewSchema(
  z
    .array(z.string())
    .transform(normalizeKeywords)
    .refine((keywords) => keywords.length > 0, "at least one keyword is required"),
);

export type TitleFieldReviewInput = z.infer<typeof titleFieldReviewSchema>;
export type DescriptionFieldReviewInput = z.infer<typeof descriptionFieldReviewSchema>;
export type KeywordsFieldReviewInput = z.infer<typeof keywordsFieldReviewSchema>;
