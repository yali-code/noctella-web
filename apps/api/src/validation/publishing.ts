import { PUBLISH_CHANNEL_VALUES, PublishChannel } from "@noctella/shared";
import { z } from "zod";

export const publishChannelSchema = z.enum(PUBLISH_CHANNEL_VALUES as [PublishChannel, ...PublishChannel[]]);

export const publishRequestSchema = z.object({
  channel: publishChannelSchema,
});

export type PublishRequestInput = z.infer<typeof publishRequestSchema>;
