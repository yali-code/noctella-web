// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAiIntakeGenerationProvider } from "../src/ai-intake/mockProvider";
import { OpenAiIntakeGenerationProvider } from "../src/ai-intake/openAiProvider";
import { createAiIntakeGenerationProvider } from "../src/ai-intake/providerFactory";
import { AI_INTAKE_PROMPT_VERSION } from "../src/ai-intake/promptBuilder";
import type { AiIntakeGenerationRequest, AiIntakePhotoReader } from "../src/ai-intake/types";
import {
  AiIntakeProviderAuthenticationError,
  AiIntakeProviderConfigurationError,
  AiIntakeProviderInvalidResponseError,
  AiIntakeProviderTooManyPhotosError,
  AiIntakeProviderUnavailableError,
} from "../src/services/errors";

const ENV_KEYS = ["AI_INTAKE_PROVIDER", "AI_INTAKE_OPENAI_API_KEY", "AI_INTAKE_OPENAI_MODEL", "AI_INTAKE_OPENAI_MAX_PHOTOS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

function fakePhotoReader(bytesByReferenceId: Record<string, string> = {}): AiIntakePhotoReader {
  return {
    read: vi.fn(async (referenceId: string) => Buffer.from(bytesByReferenceId[referenceId] ?? "fake-bytes")),
  };
}

function fakeRequest(
  photoCount: number,
  photoReader: AiIntakePhotoReader = fakePhotoReader(),
  allowedCategories: Array<{ id: string; name: string }> = [],
): AiIntakeGenerationRequest {
  return {
    context: {
      intakeId: "intake-1",
      photos: Array.from({ length: photoCount }, (_, i) => ({
        id: `photo-${i}`,
        originalFilename: `photo-${i}.webp`,
        referenceId: `photo-${i}`,
      })),
      allowedCategories,
    },
    prompt: { version: AI_INTAKE_PROMPT_VERSION, systemPrompt: "system", userPrompt: "user" },
    photoReader,
  };
}

function rawResponse(body: unknown, init: { status?: number } = {}) {
  return { ok: (init.status ?? 200) < 400, status: init.status ?? 200, json: async () => body } as Response;
}

/**
 * Sprint 106: OpenAI's strict Structured Outputs mode requires every schema
 * property to be present in a real response (missing/"optional" fields are
 * represented as `null`, never an omitted key) - see
 * openAiOutputSchema.ts's buildAiIntakeOpenAiResponseZodSchema, which has no
 * `.optional()` anywhere. Test payloads below only specify the fields each
 * test actually cares about; this default fills every other one of the
 * twelve expanded suggestion fields with `null`, mirroring exactly what a
 * real strict-mode response looks like for an unrequested field.
 */
const DEFAULT_PROPOSAL_FIELDS = {
  suggestedTitle: null,
  suggestedDescription: null,
  suggestedKeywords: null,
  confidenceScore: null,
  suggestedCategoryId: null,
  suggestedBrand: null,
  suggestedModel: null,
  suggestedManufacturer: null,
  suggestedCountryOfOrigin: null,
  suggestedPeriod: null,
  suggestedMaterials: null,
  suggestedCondition: null,
  suggestedConditionDescription: null,
  suggestedSeoTitle: null,
  suggestedMetaDescription: null,
  suggestedPriceEur: null,
} as const;

/**
 * Sprint 101 correction: builds the actual documented raw REST response
 * shape (`output[]` -> `{type: "message", content: [...]}` -> `{type:
 * "output_text", text}`) - NOT the SDK-only `output_text` convenience field,
 * which does not exist on the raw HTTP response body. Every "successful
 * response" test in this file goes through this helper, so they all
 * exercise the same parsing path a real API call would use. `payload` is
 * merged onto DEFAULT_PROPOSAL_FIELDS (not replacing it) so each test only
 * needs to specify the fields it actually cares about.
 */
function structuredOutputResponse(payload: Record<string, unknown>, init: { status?: number } = {}) {
  return rawResponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...DEFAULT_PROPOSAL_FIELDS, ...payload }) }] }] }, init);
}

describe("AI Intake provider factory (Sprint 101)", () => {
  it("unset AI_INTAKE_PROVIDER selects the Mock provider", () => {
    expect(createAiIntakeGenerationProvider()).toBeInstanceOf(MockAiIntakeGenerationProvider);
  });

  it('AI_INTAKE_PROVIDER="mock" selects the Mock provider', () => {
    process.env.AI_INTAKE_PROVIDER = "mock";
    expect(createAiIntakeGenerationProvider()).toBeInstanceOf(MockAiIntakeGenerationProvider);
  });

  it('AI_INTAKE_PROVIDER="openai" with valid config selects the OpenAI provider', () => {
    process.env.AI_INTAKE_PROVIDER = "openai";
    process.env.AI_INTAKE_OPENAI_API_KEY = "sk-test";
    process.env.AI_INTAKE_OPENAI_MODEL = "gpt-test";
    process.env.AI_INTAKE_OPENAI_MAX_PHOTOS = "4";
    expect(createAiIntakeGenerationProvider()).toBeInstanceOf(OpenAiIntakeGenerationProvider);
  });

  it("an unsupported provider value fails closed with a typed configuration error", () => {
    process.env.AI_INTAKE_PROVIDER = "claude";
    expect(() => createAiIntakeGenerationProvider()).toThrow(AiIntakeProviderConfigurationError);
  });

  it.each([
    ["missing API key", { AI_INTAKE_OPENAI_MODEL: "gpt-test", AI_INTAKE_OPENAI_MAX_PHOTOS: "4" }],
    ["missing model", { AI_INTAKE_OPENAI_API_KEY: "sk-test", AI_INTAKE_OPENAI_MAX_PHOTOS: "4" }],
    ["missing max photos", { AI_INTAKE_OPENAI_API_KEY: "sk-test", AI_INTAKE_OPENAI_MODEL: "gpt-test" }],
  ])("openai provider with %s fails closed before any network call", (_label, vars) => {
    process.env.AI_INTAKE_PROVIDER = "openai";
    Object.assign(process.env, vars);
    const fetchSpy = vi.spyOn(global, "fetch");
    expect(() => createAiIntakeGenerationProvider()).toThrow(AiIntakeProviderConfigurationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["not-a-number", "0", "-1", "1.5"])("invalid AI_INTAKE_OPENAI_MAX_PHOTOS value %s fails closed before any network call", (value) => {
    process.env.AI_INTAKE_PROVIDER = "openai";
    process.env.AI_INTAKE_OPENAI_API_KEY = "sk-test";
    process.env.AI_INTAKE_OPENAI_MODEL = "gpt-test";
    process.env.AI_INTAKE_OPENAI_MAX_PHOTOS = value;
    const fetchSpy = vi.spyOn(global, "fetch");
    expect(() => createAiIntakeGenerationProvider()).toThrow(AiIntakeProviderConfigurationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OpenAiIntakeGenerationProvider (Sprint 101)", () => {
  function provider(maxPhotos = 6) {
    return new OpenAiIntakeGenerationProvider({ apiKey: "sk-test", model: "gpt-test", maxPhotos });
  }

  it("rejects when the intake has more staged photos than the configured limit, without calling fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await expect(provider(2).generate(fakeRequest(3))).rejects.toBeInstanceOf(AiIntakeProviderTooManyPhotosError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends each photo's bytes as a base64 image_url data URL, never a filesystem path or public URL", async () => {
    const reader = fakePhotoReader({ "photo-0": "hello-bytes" });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      structuredOutputResponse({ suggestedTitle: "A title", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null }),
    );

    await provider().generate(fakeRequest(1, reader));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse((init as RequestInit).body as string);
    const imageInput = body.input[0].content.find((c: { type: string }) => c.type === "input_image");
    expect(imageInput.image_url).toBe(`data:image/webp;base64,${Buffer.from("hello-bytes").toString("base64")}`);
    expect(JSON.stringify(body)).not.toMatch(/[A-Za-z]:\\|\/uploads\//);
  });

  it("never sends the API key anywhere except the Authorization header", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      structuredOutputResponse({ suggestedTitle: null, suggestedDescription: null, suggestedKeywords: null, confidenceScore: null }),
    );
    await provider().generate(fakeRequest(0));
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect((init as RequestInit).body as string).not.toContain("sk-test");
  });

  it("maps a successful raw REST structured response into the existing AiIntakeGenerationResult contract", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      structuredOutputResponse({
        suggestedTitle: "Vintage brass clock",
        suggestedDescription: "A well-preserved mantel clock.",
        suggestedKeywords: ["clock", "brass", "clock"],
        confidenceScore: 0.87,
      }),
    );

    const result = await provider().generate(fakeRequest(0));

    expect(result.proposal.suggestedTitle).toBe("Vintage brass clock");
    expect(result.proposal.suggestedDescription).toBe("A well-preserved mantel clock.");
    expect(result.proposal.suggestedKeywords).toEqual(["clock", "brass", "clock"]);
    expect(result.proposal.confidenceScore).toBe(0.87);
    expect(result.metadata.providerName).toBe("openai-intake-v1:gpt-test");
    expect(result.metadata.promptVersion).toBe(AI_INTAKE_PROMPT_VERSION);
  });

  it("maps null suggestion fields to undefined, never null or empty string/array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      structuredOutputResponse({ suggestedTitle: null, suggestedDescription: "", suggestedKeywords: [], confidenceScore: null }),
    );
    const result = await provider().generate(fakeRequest(0));
    expect(result.proposal.suggestedTitle).toBeUndefined();
    expect(result.proposal.suggestedDescription).toBeUndefined();
    expect(result.proposal.suggestedKeywords).toBeUndefined();
    expect(result.proposal.confidenceScore).toBeUndefined();
  });

  describe("Sprint 106: expanded AI Full Product Analysis fields", () => {
    it("maps a successful response's twelve expanded fields into the AiIntakeProposal contract unchanged", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        structuredOutputResponse({
          suggestedCategoryId: "cat-1",
          suggestedBrand: "Acme",
          suggestedModel: "Model X",
          suggestedManufacturer: "Acme Corp",
          suggestedCountryOfOrigin: "Germany",
          suggestedPeriod: "1920s",
          suggestedMaterials: "Oak",
          suggestedCondition: "Good",
          suggestedConditionDescription: "Minor wear",
          suggestedSeoTitle: "Antique Oak Item",
          suggestedMetaDescription: "A fine antique item.",
          suggestedPriceEur: 42.5,
        }),
      );
      const result = await provider().generate(fakeRequest(0, undefined, [{ id: "cat-1", name: "Furniture" }]));
      expect(result.proposal.suggestedCategoryId).toBe("cat-1");
      expect(result.proposal.suggestedBrand).toBe("Acme");
      expect(result.proposal.suggestedModel).toBe("Model X");
      expect(result.proposal.suggestedManufacturer).toBe("Acme Corp");
      expect(result.proposal.suggestedCountryOfOrigin).toBe("Germany");
      expect(result.proposal.suggestedPeriod).toBe("1920s");
      expect(result.proposal.suggestedMaterials).toBe("Oak");
      expect(result.proposal.suggestedCondition).toBe("Good");
      expect(result.proposal.suggestedConditionDescription).toBe("Minor wear");
      expect(result.proposal.suggestedSeoTitle).toBe("Antique Oak Item");
      expect(result.proposal.suggestedMetaDescription).toBe("A fine antique item.");
      expect(result.proposal.suggestedPriceEur).toBe(42.5);
    });

    it("null-when-unsure: every expanded field maps to undefined (never a fabricated value), matching the base fields' convention", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({}));
      const result = await provider().generate(fakeRequest(0));
      expect(result.proposal.suggestedCategoryId).toBeUndefined();
      expect(result.proposal.suggestedBrand).toBeUndefined();
      expect(result.proposal.suggestedModel).toBeUndefined();
      expect(result.proposal.suggestedManufacturer).toBeUndefined();
      expect(result.proposal.suggestedCountryOfOrigin).toBeUndefined();
      expect(result.proposal.suggestedPeriod).toBeUndefined();
      expect(result.proposal.suggestedMaterials).toBeUndefined();
      expect(result.proposal.suggestedCondition).toBeUndefined();
      expect(result.proposal.suggestedConditionDescription).toBeUndefined();
      expect(result.proposal.suggestedSeoTitle).toBeUndefined();
      expect(result.proposal.suggestedMetaDescription).toBeUndefined();
      expect(result.proposal.suggestedPriceEur).toBeUndefined();
    });

    it("category constraint: the allowed category list is sent both as JSON Schema enum and as readable request text, and a real category id in the response is accepted", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedCategoryId: "cat-2" }));
      const result = await provider().generate(
        fakeRequest(0, undefined, [{ id: "cat-1", name: "Furniture" }, { id: "cat-2", name: "Clocks" }]),
      );
      const [, init] = fetchSpy.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.text.format.schema.properties.suggestedCategoryId.enum).toEqual(["cat-1", "cat-2", null]);
      const categoryText = body.input[0].content.find((c: { type: string; text?: string }) => c.type === "input_text" && c.text?.includes("Available categories"));
      expect(categoryText.text).toContain("cat-1 = Furniture");
      expect(categoryText.text).toContain("cat-2 = Clocks");
      expect(result.proposal.suggestedCategoryId).toBe("cat-2");
    });

    it("category constraint: a response category id outside the allowed list is rejected as an invalid response, never silently accepted", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedCategoryId: "cat-invented" }));
      await expect(provider().generate(fakeRequest(0, undefined, [{ id: "cat-1", name: "Furniture" }]))).rejects.toBeInstanceOf(
        AiIntakeProviderInvalidResponseError,
      );
    });

    it("category constraint: an empty allowed-category list degenerates to null-only - any non-null response value is rejected", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedCategoryId: "cat-1" }));
      await expect(provider().generate(fakeRequest(0, undefined, []))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("empty allowed-category list still sends a request (degenerate but not a crash) and a null response category id is accepted", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedCategoryId: null }));
      const result = await provider().generate(fakeRequest(0, undefined, []));
      expect(result.proposal.suggestedCategoryId).toBeUndefined();
    });

    it("priceEur suggestion: schema-bounded to non-negative, an out-of-range negative value is rejected (never clamped)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedPriceEur: -5 }));
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });
  });

  describe("raw REST response shape (Sprint 101 correction)", () => {
    it("does NOT accept the SDK-only top-level output_text convenience field (absent from raw REST responses)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        rawResponse({
          output_text: JSON.stringify({ suggestedTitle: "x", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null }),
        }),
      );
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("throws a typed invalid-response error when no output array is present at all", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ unexpected: "shape" }));
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("throws a typed invalid-response error when an output item is missing its content array", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ output: [{ type: "message" }] }));
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it('throws a typed invalid-response error when the output item type is not "message"', async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        rawResponse({ output: [{ type: "function_call", content: [{ type: "output_text", text: "{}" }] }] }),
      );
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("throws a typed invalid-response error when the model returns a refusal instead of output_text", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        rawResponse({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] }),
      );
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("throws a typed invalid-response error for malformed JSON inside the output_text content item's text", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }));
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("throws a typed invalid-response error when the parsed structured output fails schema validation", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(structuredOutputResponse({ suggestedTitle: 12345 }));
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });
  });

  describe("confidenceScore strict [0,1] validation (Sprint 101 correction)", () => {
    it.each([0, 1, 0.42])("accepts a valid confidenceScore of %s unchanged (no clamping)", async (score) => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        structuredOutputResponse({ suggestedTitle: null, suggestedDescription: null, suggestedKeywords: null, confidenceScore: score }),
      );
      const result = await provider().generate(fakeRequest(0));
      expect(result.proposal.confidenceScore).toBe(score);
    });

    it.each([-1, 1.5, 100])("rejects an out-of-range confidenceScore of %s with a typed invalid-response error (never clamped)", async (score) => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        structuredOutputResponse({ suggestedTitle: null, suggestedDescription: null, suggestedKeywords: null, confidenceScore: score }),
      );
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });

    it("rejects a wrong-type confidenceScore (string) with a typed invalid-response error", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        structuredOutputResponse({ suggestedTitle: null, suggestedDescription: null, suggestedKeywords: null, confidenceScore: "0.5" }),
      );
      await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderInvalidResponseError);
    });
  });

  it("throws a typed authentication error on HTTP 401, without exposing the response body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ error: "invalid_api_key: sk-real-secret" }, { status: 401 }));
    let caught: unknown;
    try {
      await provider().generate(fakeRequest(0));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiIntakeProviderAuthenticationError);
    expect((caught as Error).message).not.toContain("sk-real-secret");
  });

  it("throws a typed authentication error on HTTP 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({}, { status: 403 }));
    await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderAuthenticationError);
  });

  it("throws a typed unavailable error on HTTP 429 (rate limit), without exposing the response body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ error: "slow down" }, { status: 429 }));
    let caught: unknown;
    try {
      await provider().generate(fakeRequest(0));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiIntakeProviderUnavailableError);
    expect((caught as Error).message).not.toContain("slow down");
  });

  it("throws a typed unavailable error on a provider-side 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({}, { status: 500 }));
    await expect(provider().generate(fakeRequest(0))).rejects.toBeInstanceOf(AiIntakeProviderUnavailableError);
  });

  it("throws a typed unavailable error on a network-level fetch rejection, without exposing the raw error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:443 (internal-network-detail)"));
    let caught: unknown;
    try {
      await provider().generate(fakeRequest(0));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiIntakeProviderUnavailableError);
    expect((caught as Error).message).not.toContain("10.0.0.1");
  });
});

describe("Mock provider preservation (Sprint 101)", () => {
  it("MockAiIntakeGenerationProvider is unaffected and still fully deterministic with zero network calls", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await new MockAiIntakeGenerationProvider().generate(fakeRequest(2));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.metadata.providerName).toBe("mock-intake-v1");
  });
});
