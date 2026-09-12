import { z } from "zod";

export const updateReturnMetadataSchema = z
  .object({
    reasonDetails: z.string().nullable().optional(),
    internalNote: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.reasonDetails !== undefined || input.internalNote !== undefined,
    { message: "At least one return metadata field is required" },
  );

export type UpdateReturnMetadataInput = z.infer<
  typeof updateReturnMetadataSchema
>;
