import { requestStructuredResponse } from "../ai/structuredResponse";
import {
  CanonicalProductProposalProviderAuthenticationError,
  CanonicalProductProposalProviderConfigurationError,
  CanonicalProductProposalProviderInvalidResponseError,
  CanonicalProductProposalProviderUnavailableError,
} from "../services/errors";
import { buildProductAiFillJsonSchema, buildProductAiFillPrompt, buildProductAiFillZodSchema, PRODUCT_AI_FILL_TEXT_FIELDS, type ProductAiFillProvider, type ProductAiFillResult } from "./contract";

/** Generating every field in one structured response takes longer than a single-domain proposal. */
const FILL_TIMEOUT_MS = 90_000;

class OpenAiProductAiFillProvider implements ProductAiFillProvider {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async fill({ context, photoReader }: Parameters<ProductAiFillProvider["fill"]>[0]): Promise<ProductAiFillResult> {
    const prompt = buildProductAiFillPrompt(context);
    const images: Array<{ type: "input_image"; image_url: string }> = [];
    for (const photo of context.photos) {
      try {
        images.push({ type: "input_image", image_url: `data:image/webp;base64,${(await photoReader.read(photo)).toString("base64")}` });
      } catch {
        // An unreadable photo must not block the fill; the remaining evidence is still usable.
      }
    }
    const parsed = await requestStructuredResponse(
      this.apiKey,
      {
        model: this.model,
        instructions: prompt.systemPrompt,
        input: [{ role: "user", content: [{ type: "input_text" as const, text: prompt.userPrompt }, ...images] }],
        text: { format: { type: "json_schema", name: "product_ai_fill", schema: buildProductAiFillJsonSchema(), strict: true } },
      },
      {
        authentication: CanonicalProductProposalProviderAuthenticationError,
        unavailable: CanonicalProductProposalProviderUnavailableError,
        invalid: CanonicalProductProposalProviderInvalidResponseError,
      },
      FILL_TIMEOUT_MS,
    );
    const validated = buildProductAiFillZodSchema().safeParse(parsed);
    if (!validated.success) throw new CanonicalProductProposalProviderInvalidResponseError();
    return validated.data as ProductAiFillResult;
  }
}

class MockProductAiFillProvider implements ProductAiFillProvider {
  async fill({ context }: Parameters<ProductAiFillProvider["fill"]>[0]): Promise<ProductAiFillResult> {
    const text = Object.fromEntries(PRODUCT_AI_FILL_TEXT_FIELDS.map((field) => [field, `Mock ${field} for ${context.title}`]));
    return { ...text, priceEur: 100, priceUsd: 110, minOfferPrice: 80, keywords: ["mock keyword"], etsyTags: ["mock tag"], marketingTags: ["Mock Tag"] } as ProductAiFillResult;
  }
}

export function createProductAiFillProvider(): ProductAiFillProvider {
  const value = process.env.CANONICAL_PRODUCT_AI_PROVIDER || "mock";
  if (value === "mock") return new MockProductAiFillProvider();
  if (value !== "openai") throw new CanonicalProductProposalProviderConfigurationError(`Unsupported CANONICAL_PRODUCT_AI_PROVIDER value: "${value}"`);
  const apiKey = process.env.AI_INTAKE_OPENAI_API_KEY;
  const model = process.env.AI_INTAKE_OPENAI_MODEL;
  if (!apiKey || !model) throw new CanonicalProductProposalProviderConfigurationError("AI_INTAKE_OPENAI_API_KEY and AI_INTAKE_OPENAI_MODEL are required for the OpenAI provider");
  return new OpenAiProductAiFillProvider(apiKey, model);
}
