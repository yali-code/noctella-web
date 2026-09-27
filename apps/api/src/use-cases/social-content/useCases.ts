import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SOCIAL_CONTENT_TYPES, type SocialContent } from "@noctella/shared";
import { BadRequestError, SocialContentGenerationConflictError } from "../../services/errors";
import { socialDraftSchema, socialHashtagsSchema, socialId, type SocialDraft } from "../../validation/socialContent";
import type { SocialContentRepository, SocialGenerationMetadata, SocialWork } from "../../repositories/social-content/types";
import { acquireSocialGenerationGuard } from "./generationGuard";

const requestIdSchema = z.string().uuid().refine((value) => value === value.toLowerCase(), "Canonical UUID required");
const identitySchema = z.object({ productId: socialId, requestId: requestIdSchema });
const identifier = z.string().trim().min(1).max(128);
// Internal only: never mounted as an HTTP request schema. Revalidate at the domain boundary.
const generatedDraftSchema = identitySchema.extend({
  contentType: z.enum(SOCIAL_CONTENT_TYPES),
  caption: z.string().max(2200).refine((value) => !!value.trim(), "Generated caption is required"),
  hashtags: socialHashtagsSchema,
  concept: z.string().trim().min(1).max(1000),
  media: z.array(z.object({ photoId: socialId, editorialAltText: z.string().trim().min(1).max(1000) }).strict()).min(1).max(10)
    .refine((items) => new Set(items.map((item) => item.photoId)).size === items.length, "Duplicate media IDs"),
  aiProvider: identifier,
  aiModel: identifier,
  aiPromptVersion: identifier,
  aiGeneratedAt: z.string().datetime(),
  sourceProductUpdatedAt: z.string().min(1),
}).strict();
export type GeneratedSocialDraftInput = z.input<typeof generatedDraftSchema>;

export function validateEditorialAltTextSelection(input: Pick<SocialDraft, "mediaIds" | "mediaEditorialAltTexts">): void {
  if (input.mediaEditorialAltTexts?.some((entry) => !input.mediaIds.includes(entry.photoId))) {
    throw new BadRequestError("Editorial alt text must reference selected media");
  }
}

export function* validateSocialSelection(repo: SocialContentRepository, tx: any, input: Pick<SocialDraft, "productId" | "mediaIds">, expectedUpdatedAt?: string): SocialWork<void> {
  if (input.productId) {
    const product = yield* repo.readProduct(tx, input.productId);
    if (!product) throw new BadRequestError("Selected product does not exist");
    const actual = product.updatedAt instanceof Date ? product.updatedAt.toISOString() : product.updatedAt;
    if (expectedUpdatedAt !== undefined && actual !== expectedUpdatedAt) throw new SocialContentGenerationConflictError("stale_product");
  }
  if (input.mediaIds.length) {
    const photos = yield* repo.readPhotos(tx, input.mediaIds);
    if (photos.length !== input.mediaIds.length) throw new BadRequestError("Selected media does not exist");
    if (photos.some((photo) => (input.productId && photo.productId !== input.productId) || photo.processingStatus !== "Ready")) {
      throw new BadRequestError("Selected media must be ready and belong to the selected product");
    }
  }
}

function* persistDraft(repo: SocialContentRepository, tx: any, input: SocialDraft, generation: SocialGenerationMetadata | null = null, expectedUpdatedAt?: string): SocialWork<SocialContent> {
  validateEditorialAltTextSelection(input);
  yield* validateSocialSelection(repo, tx, input, expectedUpdatedAt);
  const timestamp = new Date().toISOString();
  return yield* repo.insertDraft(tx, {
    id: randomUUID(), platform: "instagram", accountLabel: "vault", status: "draft", version: 1,
    contentType: input.contentType, caption: input.caption, productId: input.productId,
    hashtags: input.hashtags ?? null, concept: input.concept ?? null,
    createdAt: timestamp, updatedAt: timestamp, generation,
  }, input.mediaIds, input.mediaEditorialAltTexts);
}

export async function createSocialDraftUseCase(repo: SocialContentRepository, value: unknown): Promise<SocialContent> {
  const input = socialDraftSchema.parse(value);
  return repo.transaction(function* (tx) { return yield* persistDraft(repo, tx, input); });
}

function replay(row: SocialContent, productId: string): SocialContent {
  if (row.aiSourceProductId !== productId) throw new SocialContentGenerationConflictError("request_mismatch");
  return row; // Preserve current human edits, version and editorial state.
}

export async function createGeneratedSocialDraftUseCase(repo: SocialContentRepository, value: GeneratedSocialDraftInput): Promise<SocialContent> {
  const identity = identitySchema.parse(value);
  const lookup = () => repo.transaction(function* (tx) { return yield* repo.findByRequest(tx, identity.requestId); });
  const completed = await lookup();
  if (completed) return replay(completed, identity.productId);
  const input = generatedDraftSchema.parse(value);
  const release = acquireSocialGenerationGuard(input.requestId, input.productId);
  try {
    return await repo.transaction(function* (tx) {
      const existing = yield* repo.findByRequest(tx, input.requestId);
      if (existing) return replay(existing, input.productId);
      return yield* persistDraft(repo, tx, {
        contentType: input.contentType, caption: input.caption, hashtags: input.hashtags, concept: input.concept,
        productId: input.productId, mediaIds: input.media.map((item) => item.photoId), mediaEditorialAltTexts: input.media,
      }, {
        aiProvider: input.aiProvider, aiModel: input.aiModel, aiPromptVersion: input.aiPromptVersion,
        aiGeneratedAt: input.aiGeneratedAt, aiRequestId: input.requestId, aiSourceProductId: input.productId,
      }, input.sourceProductUpdatedAt);
    });
  } catch (error) {
    // PostgreSQL aborts a transaction on constraint failure; read the winner only after rollback.
    if (repo.isRequestConflict(error)) {
      const winner = await lookup();
      if (winner) return replay(winner, input.productId);
    }
    throw error;
  } finally {
    release();
  }
}
