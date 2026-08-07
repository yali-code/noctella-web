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

function fakeRequest(photoCount: number, photoReader: AiIntakePhotoReader = fakePhotoReader()): AiIntakeGenerationRequest {
  return {
    context: {
      intakeId: "intake-1",
      photos: Array.from({ length: photoCount }, (_, i) => ({
        id: `photo-${i}`,
        originalFilename: `photo-${i}.webp`,
        referenceId: `photo-${i}`,
      })),
    },
    prompt: { version: AI_INTAKE_PROMPT_VERSION, systemPrompt: "system", userPrompt: "user" },
    photoReader,
  };
}

function rawResponse(body: unknown, init: { status?: number } = {}) {
  return { ok: (init.status ?? 200) < 400, status: init.status ?? 200, json: async () => body } as Response;
}

/**
 * Sprint 101 correction: builds the actual documented raw REST response
 * shape (`output[]` -> `{type: "message", content: [...]}` -> `{type:
 * "output_text", text}`) - NOT the SDK-only `output_text` convenience field,
 * which does not exist on the raw HTTP response body. Every "successful
 * response" test in this file goes through this helper, so they all
 * exercise the same parsing path a real API call would use.
 */
function structuredOutputResponse(payload: unknown, init: { status?: number } = {}) {
  return rawResponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }] }, init);
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
