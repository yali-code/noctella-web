import { PUBLISH_CHANNEL_VALUES, PublishChannel } from "@noctella/shared";
import { z } from "zod";

export const publishChannelSchema = z.enum(PUBLISH_CHANNEL_VALUES as [PublishChannel, ...PublishChannel[]]);

export const publishRequestSchema = z.object({
  channel: publishChannelSchema,
});

export type PublishRequestInput = z.infer<typeof publishRequestSchema>;

/**
 * Sprint 141: the unified/batch publish request - `channels` reuses publishChannelSchema per
 * element (never a duplicated channel enum). `.strict()` rejects any unrecognized field, including
 * a client-supplied idempotencyKey - the batch endpoint deliberately has no batch-level idempotency
 * key (each selected channel always uses executePublish's own existing per-channel default key, so
 * accepting and forwarding one shared key here would collide across channels against publishJobs'
 * unique idempotencyKey constraint). At least one channel is required; duplicate channel values are
 * accepted here and deduplicated in services/marketplacePublishing.ts's executePublishBatch, not
 * rejected - a harmless repeated selection should not fail the whole request.
 */
export const executePublishBatchRequestSchema = z
  .object({
    channels: z.array(publishChannelSchema).min(1, "At least one channel is required"),
  })
  .strict();

export type ExecutePublishBatchRequestInput = z.infer<typeof executePublishBatchRequestSchema>;
