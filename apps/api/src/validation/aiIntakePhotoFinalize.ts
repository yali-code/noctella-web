import { z } from "zod";

/**
 * Sprint 95: strict finalize-photos request. Only an optional explicit
 * Primary selection is ever accepted from the client - Product id,
 * ProductPhoto ids, staged photo lists, order, storage keys, paths, MIME
 * types, file sizes, actor id, intake status, finalization timestamps,
 * Product status, and publishing/marketplace/cleanup fields are always
 * server-controlled and never accepted here.
 */
export const finalizeAiIntakePhotosSchema = z
  .object({ primaryIntakePhotoId: z.string().min(1, "primaryIntakePhotoId must not be empty").optional() })
  .strict();

export type FinalizeAiIntakePhotosInput = z.infer<typeof finalizeAiIntakePhotosSchema>;
