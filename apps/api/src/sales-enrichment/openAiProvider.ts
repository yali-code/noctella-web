import {
  SalesEnrichmentProviderAuthenticationError,
  SalesEnrichmentProviderInvalidResponseError,
  SalesEnrichmentProviderUnavailableError,
} from "../services/errors";
import { buildSalesEnrichmentOpenAiResponseJsonSchema, buildSalesEnrichmentOpenAiResponseZodSchema, toSalesEnrichmentResult } from "./openAiOutputSchema";
import type { SalesEnrichmentGenerationRequest, SalesEnrichmentGenerationResult, SalesEnrichmentProvider } from "./types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;

export interface SalesEnrichmentOpenAiProviderConfig {
  apiKey: string;
  model: string;
}

/**
 * Sprint 140: appended to DeterministicSalesEnrichmentPromptBuilder's systemPrompt
 * (./promptBuilder.ts), never replacing it - guardrail text meaningful only for a real model.
 * Mirrors marketplace-prep/openAiProvider.ts's OPENAI_SYSTEM_PROMPT_ADDENDUM precedent exactly,
 * scoped to this provider's own narrow output (Marketing Tags only, never a price).
 */
const OPENAI_SYSTEM_PROMPT_ADDENDUM =
  "Suggest tags only when reasonably supported by the supplied canonical product information. The supplied fields are operator-accepted " +
  "context, not independently verified facts. Never invent a gifting occasion, collector interest, or commercial angle that is not clearly " +
  "evidenced - return an empty list rather than fabricate a tag. Never suggest a price. " +
  "You are producing a draft suggestion for human review only - you never publish anything, change stock, or set Product identity.";

/**
 * Sprint 140: minimal real-provider implementation of SalesEnrichmentProvider (./types.ts).
 * Never writes Product/Inventory, never touches publishing state - identical contract shape to
 * marketplace-prep/openAiProvider.ts's OpenAiMarketplacePreparationProvider, scoped to a single
 * Product-level Marketing Tags suggestion. Uses Node's native fetch (no new dependency). Text-only
 * - no image input, no photo access (this call needs none, mirroring marketplace-prep's own
 * documented rationale).
 */
export class OpenAiSalesEnrichmentProvider implements SalesEnrichmentProvider {
  constructor(private readonly config: SalesEnrichmentOpenAiProviderConfig) {}

  async generate(request: SalesEnrichmentGenerationRequest): Promise<SalesEnrichmentGenerationResult> {
    const { prompt } = request;

    const body = {
      model: this.config.model,
      instructions: `${prompt.systemPrompt}\n\n${OPENAI_SYSTEM_PROMPT_ADDENDUM}`,
      input: [{ role: "user", content: [{ type: "input_text" as const, text: prompt.userPrompt }] }],
      text: {
        format: {
          type: "json_schema",
          name: "sales_enrichment_result",
          schema: buildSalesEnrichmentOpenAiResponseJsonSchema(),
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
      throw new SalesEnrichmentProviderUnavailableError();
    }

    if (res.status === 401 || res.status === 403) {
      throw new SalesEnrichmentProviderAuthenticationError();
    }
    if (!res.ok) {
      // Covers rate limiting (429) and any provider-side 5xx - never the raw response body.
      throw new SalesEnrichmentProviderUnavailableError();
    }

    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
    } catch {
      throw new SalesEnrichmentProviderInvalidResponseError();
    }

    const outputText = extractOutputText(parsedBody);
    if (outputText === null) throw new SalesEnrichmentProviderInvalidResponseError();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch {
      throw new SalesEnrichmentProviderInvalidResponseError();
    }

    const validated = buildSalesEnrichmentOpenAiResponseZodSchema().safeParse(parsedJson);
    if (!validated.success) throw new SalesEnrichmentProviderInvalidResponseError();

    return {
      result: toSalesEnrichmentResult(validated.data),
      metadata: {
        providerName: `openai-sales-enrichment-v1:${this.config.model}`,
        promptVersion: prompt.version,
      },
    };
  }
}

/**
 * Sprint 140: parses the raw Responses API REST response only via its documented `output[]` ->
 * message item (`type: "message"`) -> `content[]` -> `output_text`-typed content item -> `text`
 * string structure - mirrors marketplace-prep/openAiProvider.ts's extractOutputText exactly.
 * Returns null (never throws) for any shape that does not match.
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
