import { z } from "zod";
import {
  ReturnItemCondition,
  ReturnStockDisposition,
} from "@noctella/shared";

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

export const inspectReturnInputSchema = z
  .object({
    orderItemId: z.string().min(1),
    quantityReceived: z.number().finite().int().min(1).optional(),
    condition: z.nativeEnum(ReturnItemCondition).nullable().optional(),
    stockDisposition: z
      .nativeEnum(ReturnStockDisposition)
      .nullable()
      .optional(),
    inspectionNote: z.string().nullable().optional(),
    inspectionResult: z.unknown().optional(),
  })
  .strict();

export type InspectReturnInput = z.infer<typeof inspectReturnInputSchema>;
