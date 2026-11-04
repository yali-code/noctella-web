import { z } from "zod";

export const fillProductWithAiSchema = z.object({ replaceExisting: z.boolean().default(false) }).strict();
