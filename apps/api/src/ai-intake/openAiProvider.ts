import {
  AiIntakeProviderAuthenticationError,
  AiIntakeProviderInvalidResponseError,
  AiIntakeProviderTooManyPhotosError,
  AiIntakeProviderUnavailableError,
} from "../services/errors";
import { AI_INTAKE_OPENAI_RESPONSE_JSON_SCHEMA, aiIntakeOpenAiResponseSchema, toAiIntakeProposal } from "./openAiOutputSchema";
import type { AiIntakeGenerationProvider, AiIntakeGenerationRequest, AiIntakeGenerationResult } from "./types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;

export interface AiIntakeOpenAiProviderConfig {
  apiKey: string;
  model: string;
  maxPhotos: number;
}

/**
 * Sprint 101: appended to the shared DeterministicAiIntakePromptBuilder's
 * systemPrompt (ai-intake/promptBuilder.ts), never replacing it and never
 * modifying that file - this addendum is guardrail text meaningful only for
 * a real model (the deterministic Mock provider never fabricates, so it
 * never needed this). Kept local to this provider only.
 */
const OPENAI_SYSTEM_PROMPT_ADDENDUM =
  "Describe only what is reasonably visible in the supplied photos and intake metadata. " +
  "Never invent or guess a maker, model, material, date, or provenance that is not clearly evidenced. " +
  "Write concise, marketplace-neutral draft text only. " +
  "You are producing a draft proposal for human review only - you never create or modify a Product, " +
  "never change Inventory, and never publish anything.";

/**
 * Sprint 101: minimal real-provider implementation of the existing
 * AiIntakeGenerationProvider interface (./types.ts) - reused as-is, no
 * interface change. Never writes Product or Inventory, never touches
 * publishing state - identical contract to MockAiIntakeGenerationProvider
 * (./mockProvider.ts), only ever returns an AiIntakeGenerationResult for
 * human review.
 *
 * Uses Node 20's native fetch (no new dependency, matching
 * services/marketplaceAdapters.ts's only existing outbound-HTTP precedent)
 * against OpenAI's Responses API with Structured Outputs. Reads image bytes
 * only via the already-injected request.photoReader (./photoReader.ts) -
 * never a filesystem path, never a public URL; images are sent as base64
 * data URLs directly in the request body, so OpenAI never fetches a
 * Noctella-hosted URL and no path is ever exposed.
 */
export class OpenAiIntakeGenerationProvider implements AiIntakeGenerationProvider {
  constructor(private readonly config: AiIntakeOpenAiProviderConfig) {}

  async generate(request: AiIntakeGenerationRequest): Promise<AiIntakeGenerationResult> {
    const { context, prompt, photoReader } = request;

    if (context.photos.length > this.config.maxPhotos) {
      throw new AiIntakeProviderTooManyPhotosError(this.config.maxPhotos, context.photos.length);
    }

    const imageInputs = await Promise.all(
      context.photos.map(async (photo) => {
        const bytes = await photoReader.read(photo.referenceId);
        return { type: "input_image" as const, image_url: `data:image/webp;base64,${bytes.toString("base64")}` };
      }),
    );

    const body = {
      model: this.config.model,
      instructions: `${prompt.systemPrompt}\n\n${OPENAI_SYSTEM_PROMPT_ADDENDUM}`,
      input: [
        {
          role: "user",
          content: [{ type: "input_text" as const, text: prompt.userPrompt }, ...imageInputs],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ai_intake_proposal",
          schema: AI_INTAKE_OPENAI_RESPONSE_JSON_SCHEMA,
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
      throw new AiIntakeProviderUnavailableError();
    }

    if (res.status === 401 || res.status === 403) {
      throw new AiIntakeProviderAuthenticationError();
    }
    if (!res.ok) {
      // Covers rate limiting (429) and any provider-side 5xx - never the raw response body (may
      // include upstream error text), a fixed safe message only.
      throw new AiIntakeProviderUnavailableError();
    }

    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
    } catch {
      throw new AiIntakeProviderInvalidResponseError();
    }

    const outputText = extractOutputText(parsedBody);
    if (outputText === null) throw new AiIntakeProviderInvalidResponseError();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch {
      throw new AiIntakeProviderInvalidResponseError();
    }

    const validated = aiIntakeOpenAiResponseSchema.safeParse(parsedJson);
    if (!validated.success) throw new AiIntakeProviderInvalidResponseError();

    return {
      proposal: toAiIntakeProposal(validated.data),
      metadata: {
        providerName: `openai-intake-v1:${this.config.model}`,
        promptVersion: prompt.version,
      },
    };
  }
}

/**
 * Sprint 101 correction: parses the raw Responses API REST response only via
 * its documented `output[]` -> message item (`type: "message"`) -> `content[]`
 * -> `output_text`-typed content item -> `text` string structure. The
 * top-level `output_text` convenience field previously accepted here does
 * NOT exist in the raw REST response body (confirmed against official
 * OpenAI documentation - it is an SDK-only aggregation helper), so it is no
 * longer checked at all. Returns null (never throws) for any shape that does
 * not match - missing `output`, a non-message item, missing `content`, a
 * refusal item (`type: "refusal"`), or any other unexpected shape - so the
 * caller always translates it into exactly one fixed
 * AiIntakeProviderInvalidResponseError.
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
