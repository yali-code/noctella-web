import { PUBLISH_CHANNEL_VALUES, PublishChannel } from "@noctella/shared";
import { z } from "zod";

export const publishChannelSchema = z.object({
  channel: z.enum(PUBLISH_CHANNEL_VALUES as [PublishChannel, ...PublishChannel[]]),
});

export type PublishChannelInput = z.infer<typeof publishChannelSchema>;
