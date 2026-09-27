import {
  CanonicalProductProposalProviderAuthenticationError,
  CanonicalProductProposalProviderInvalidResponseError,
  CanonicalProductProposalProviderUnavailableError,
} from "../services/errors";
import {
  buildCanonicalProductProposalOpenAiResponseJsonSchema,
  buildCanonicalProductProposalOpenAiResponseZodSchema,
  toCanonicalProductProposal,
} from "./openAiOutputSchema";
import type { CanonicalProductProposalGenerationRequest, CanonicalProductProposalGenerationResult, CanonicalProductProposalProvider } from "./types";

import { requestStructuredResponse } from "../ai/structuredResponse";

export interface CanonicalProductProposalOpenAiProviderConfig {
  apiKey: string;
  model: string;
}

/**
 * Sprint 148: appended to DeterministicCanonicalProductProposalPromptBuilder's systemPrompt
 * (./promptBuilder.ts), never replacing it - guardrail text meaningful only for a real model,
 * mirroring ai-intake/openAiProvider.ts's and marketplace-prep/openAiProvider.ts's own
 * OPENAI_SYSTEM_PROMPT_ADDENDUM precedent exactly.
 */
const OPENAI_SYSTEM_PROMPT_ADDENDUM =
  "You are producing a draft proposal for human review only - a human must explicitly Accept before anything changes, and Accept applies only the " +
  "specific fields the human selects. Never invent a fact not clearly evidenced by the supplied text or photographs. Leave any field null/unknown " +
  "rather than fabricate it, and strictly follow the physical measurement rule above - no exact length, width, height, or weight without explicit " +
  "readable evidence in the attached photographs.";

/**
 * Sprint 148: minimal real-provider implementation of CanonicalProductProposalProvider
 * (./types.ts) - a dedicated, isolated provider/context path (never marketplace-prep's providers
 * turned into vision providers, per Architecture Review item F). Never writes Product, Inventory,
 * or Marketing Tags itself - only ever returns a CanonicalProductProposalGenerationResult for
 * human review, identical contract shape to MockCanonicalProductProposalProvider.
 *
 * Uses Node's native fetch (no new dependency, mirroring ai-intake/openAiProvider.ts's own
 * precedent) against OpenAI's Responses API with Structured Outputs. Reuses ai-intake's proven
 * image-transport technique exactly: real bytes read via the injected photoReader, sent as
 * base64 `data:image/webp;base64,...` input_image blocks - OpenAI never fetches a Noctella URL.
 * context.photos is already ordered (primary-first, then sortOrder, then id) and capped to the
 * configured maximum by the caller (context.ts) - this provider never re-orders or re-truncates
 * it. A photo whose bytes cannot be read (missing file) is skipped, not fatal - generation
 * continues with whichever photos were readable; if none were, Physical Information is omitted
 * (via imagesUsedCount === 0, enforced in openAiOutputSchema.ts's sanitizer) but Product Details
 * and Marketing Tags can still be generated from text context alone.
 */
export class OpenAiCanonicalProductProposalProvider implements CanonicalProductProposalProvider {
  constructor(private readonly config: CanonicalProductProposalOpenAiProviderConfig) {}

  async generate(request: CanonicalProductProposalGenerationRequest): Promise<CanonicalProductProposalGenerationResult> {
    const { context, prompt, photoReader } = request;

    const imageInputs: Array<{ type: "input_image"; image_url: string }> = [];
    for (const photo of context.photos) {
      try {
        const bytes = await photoReader.read(photo);
        imageInputs.push({ type: "input_image", image_url: `data:image/webp;base64,${bytes.toString("base64")}` });
      } catch {
        // Missing/unreadable file - omit this one image and continue with the rest (Architecture
        // Review item F: never crash the Product editor over one unavailable photo file).
      }
    }
    const imagesUsedCount = imageInputs.length;

    const body = {
      model: this.config.model,
      instructions: `${prompt.systemPrompt}\n\n${OPENAI_SYSTEM_PROMPT_ADDENDUM}`,
      input: [{ role: "user", content: [{ type: "input_text" as const, text: prompt.userPrompt }, ...imageInputs] }],
      text: {
        format: {
          type: "json_schema",
          name: "canonical_product_ai_proposal",
          schema: buildCanonicalProductProposalOpenAiResponseJsonSchema(),
          strict: true,
        },
      },
    };

    const parsedJson = await requestStructuredResponse(this.config.apiKey, body, {
      authentication: CanonicalProductProposalProviderAuthenticationError,
      unavailable: CanonicalProductProposalProviderUnavailableError,
      invalid: CanonicalProductProposalProviderInvalidResponseError,
    });

    const validated = buildCanonicalProductProposalOpenAiResponseZodSchema().safeParse(parsedJson);
    if (!validated.success) throw new CanonicalProductProposalProviderInvalidResponseError();

    return {
      proposal: toCanonicalProductProposal(validated.data as Record<string, string | number | string[] | null>, imagesUsedCount),
      metadata: {
        providerName: `openai-canonical-product-ai-v1:${this.config.model}`,
        promptVersion: prompt.version,
        imagesUsedCount,
      },
    };
  }
}
