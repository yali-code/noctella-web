import {
  MarketplacePreparationProviderAuthenticationError,
  MarketplacePreparationProviderInvalidResponseError,
  MarketplacePreparationProviderUnavailableError,
} from "../services/errors";
import { buildMarketplacePreparationOpenAiResponseJsonSchema, buildMarketplacePreparationOpenAiResponseZodSchema, toMarketplacePreparationProposal } from "./openAiOutputSchema";
import type { MarketplacePreparationGenerationRequest, MarketplacePreparationGenerationResult, MarketplacePreparationProvider } from "./types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;

export interface MarketplacePreparationOpenAiProviderConfig {
  apiKey: string;
  model: string;
}

/**
 * Sprint 107: appended to DeterministicMarketplacePreparationPromptBuilder's
 * systemPrompt (./promptBuilder.ts), never replacing it - this addendum is
 * guardrail text meaningful only for a real model (the deterministic Mock
 * provider never fabricates, so it never needed this). Kept local to this
 * provider only, mirroring ai-intake/openAiProvider.ts's own
 * OPENAI_SYSTEM_PROMPT_ADDENDUM precedent exactly.
 */
const OPENAI_SYSTEM_PROMPT_ADDENDUM =
  "Describe only what is reasonably supported by the supplied canonical product information. The supplied fields are operator-accepted context, " +
  "not independently verified facts - if a supplied maker, brand, manufacturer, or model identity is clearly implausible (for example, a raw " +
  "material or a generic word rather than a genuine identity), treat it as unknown and omit it rather than confidently restating it. " +
  "Never invent or guess a maker, model, material, date, provenance, condition defect, measurement, compatibility claim, or rarity claim that is " +
  "not clearly evidenced - leave a field null/unknown rather than fabricate it. " +
  "Adapt wording and SEO structure only; never change the underlying facts, and never suggest a marketplace-specific price. " +
  "You are producing a draft proposal for human review only - you never publish anything, change stock, or set Product status.";

/**
 * Sprint 107: minimal real-provider implementation of
 * MarketplacePreparationProvider (./types.ts). Never writes Product or
 * Inventory, never touches publishing state - identical contract to
 * MockMarketplacePreparationProvider (./mockProvider.ts), only ever returns
 * a MarketplacePreparationGenerationResult for human review.
 *
 * Uses Node's native fetch (no new dependency, mirroring
 * ai-intake/openAiProvider.ts's own precedent) against OpenAI's Responses
 * API with Structured Outputs. Text-only - no image input, no photo access
 * (see ./types.ts's MarketplacePreparationProductContext doc comment for
 * why no vision input is needed for this Sprint's approved field scope).
 */
export class OpenAiMarketplacePreparationProvider implements MarketplacePreparationProvider {
  constructor(private readonly config: MarketplacePreparationOpenAiProviderConfig) {}

  async generate(request: MarketplacePreparationGenerationRequest): Promise<MarketplacePreparationGenerationResult> {
    const { context, prompt } = request;
    const channel = context.channel;

    const body = {
      model: this.config.model,
      instructions: `${prompt.systemPrompt}\n\n${OPENAI_SYSTEM_PROMPT_ADDENDUM}`,
      input: [{ role: "user", content: [{ type: "input_text" as const, text: prompt.userPrompt }] }],
      text: {
        format: {
          type: "json_schema",
          name: "marketplace_preparation_proposal",
          schema: buildMarketplacePreparationOpenAiResponseJsonSchema(channel),
          strict: true,
        },
      },
    };

    let res: Response;
    try {
      res = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network-level failure (DNS, connection refused, timeout) - never the raw error (may embed
      // connection details), a fixed safe message only.
      throw new MarketplacePreparationProviderUnavailableError();
    }

    if (res.status === 401 || res.status === 403) {
      throw new MarketplacePreparationProviderAuthenticationError();
    }
    if (!res.ok) {
      // Covers rate limiting (429) and any provider-side 5xx - never the raw response body (may
      // include upstream error text), a fixed safe message only.
      throw new MarketplacePreparationProviderUnavailableError();
    }

    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
    } catch {
      throw new MarketplacePreparationProviderInvalidResponseError();
    }

    const outputText = extractOutputText(parsedBody);
    if (outputText === null) throw new MarketplacePreparationProviderInvalidResponseError();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch {
      throw new MarketplacePreparationProviderInvalidResponseError();
    }

    const validated = buildMarketplacePreparationOpenAiResponseZodSchema(channel).safeParse(parsedJson);
    if (!validated.success) throw new MarketplacePreparationProviderInvalidResponseError();

    return {
      proposal: toMarketplacePreparationProposal(channel, validated.data as Record<string, string | string[] | null>),
      metadata: {
        providerName: `openai-marketplace-prep-v1:${this.config.model}`,
        promptVersion: prompt.version,
      },
    };
  }
}

/**
 * Sprint 107: parses the raw Responses API REST response only via its
 * documented `output[]` -> message item (`type: "message"`) -> `content[]`
 * -> `output_text`-typed content item -> `text` string structure - mirrors
 * ai-intake/openAiProvider.ts's own extractOutputText exactly (that
 * function's Sprint 101 correction already confirmed this is the real raw
 * REST shape, not the SDK-only top-level `output_text` convenience field).
 * Returns null (never throws) for any shape that does not match, so the
 * caller always translates it into exactly one fixed
 * MarketplacePreparationProviderInvalidResponseError.
 */
function extractOutputText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.output)) return null;

  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (message.type !== "message") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const c = contentItem as Record<string, unknown>;
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }

  return null;
}
