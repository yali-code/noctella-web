// @vitest-environment node
// Sprint 148: proves the canonical Product AI provider's image transport (real bytes, base64
// data URL, never a public URL), photo ordering/capping, graceful degradation on an unreadable
// photo file, the "zero images -> physical omitted" rule end-to-end, and provider error mapping -
// mirroring aiIntakeOpenAiProvider.test.ts's proven fetch-mocking pattern exactly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderAndCapCanonicalProductPhotos } from "../src/canonical-product-ai/context";
import { OpenAiCanonicalProductProposalProvider } from "../src/canonical-product-ai/openAiProvider";
import { CANONICAL_PRODUCT_PROPOSAL_PROMPT_VERSION } from "../src/canonical-product-ai/promptBuilder";
import type { CanonicalProductPhotoReader, CanonicalProductProposalGenerationRequest } from "../src/canonical-product-ai/types";
import {
  CanonicalProductProposalProviderAuthenticationError,
  CanonicalProductProposalProviderInvalidResponseError,
  CanonicalProductProposalProviderUnavailableError,
} from "../src/services/errors";

afterEach(() => vi.restoreAllMocks());

describe("Sprint 148: orderAndCapCanonicalProductPhotos", () => {
  it("orders primary-first, then sortOrder, then a stable id tie-break", () => {
    const photos = [
      { id: "b", url: "/images/product-photos/b.webp", isPrimary: false, sortOrder: 1 },
      { id: "a", url: "/images/product-photos/a.webp", isPrimary: false, sortOrder: 0 },
      { id: "c", url: "/images/product-photos/c.webp", isPrimary: true, sortOrder: 2 },
    ];
    const ordered = orderAndCapCanonicalProductPhotos(photos, 10);
    expect(ordered.map((p) => p.id)).toEqual(["c", "a", "b"]); // primary first, then sortOrder ascending
  });

  it("caps to the configured maximum", () => {
    const photos = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, url: `/images/product-photos/p${i}.webp`, isPrimary: false, sortOrder: i }));
    const ordered = orderAndCapCanonicalProductPhotos(photos, 3);
    expect(ordered).toHaveLength(3);
    expect(ordered.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
  });
});

function fakePhotoReader(bytesByPhotoId: Record<string, string | Error> = {}): CanonicalProductPhotoReader {
  return {
    read: vi.fn(async (photo: { id: string }) => {
      const entry = bytesByPhotoId[photo.id];
      if (entry instanceof Error) throw entry;
      return Buffer.from(entry ?? "fake-bytes");
    }),
  };
}

function fakeRequest(photoIds: string[], photoReader: CanonicalProductPhotoReader): CanonicalProductProposalGenerationRequest {
  return {
    context: {
      productId: "product-1",
      title: "Moon Watch",
      photos: photoIds.map((id) => ({ id, url: `/images/product-photos/${id}.webp` })),
    },
    prompt: { version: CANONICAL_PRODUCT_PROPOSAL_PROMPT_VERSION, systemPrompt: "system", userPrompt: "user" },
    photoReader,
  };
}

function rawResponse(body: unknown, init: { status?: number } = {}) {
  return { ok: (init.status ?? 200) < 400, status: init.status ?? 200, json: async () => body } as Response;
}

function fullFieldResponseBody() {
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              suggestedBrand: "Omega",
              suggestedModel: null,
              suggestedManufacturer: null,
              suggestedCountryOfOrigin: null,
              suggestedPeriod: null,
              suggestedMaterials: null,
              suggestedDescription: null,
              suggestedProductStory: null,
              suggestedCondition: null,
              suggestedConditionDescription: null,
              suggestedLengthValue: 8.5,
              suggestedWidthValue: null,
              suggestedHeightValue: null,
              suggestedDimensionUnit: "cm",
              suggestedWeightValue: null,
              suggestedWeightUnit: null,
              suggestedMarketingTags: null,
            }),
          },
        ],
      },
    ],
  };
}

describe("Sprint 148: OpenAiCanonicalProductProposalProvider", () => {
  it("sends each successfully-read photo's bytes as a base64 image_url data URL, never a filesystem path or public URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(fullFieldResponseBody()));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    await provider.generate(fakeRequest(["p1", "p2"], fakePhotoReader({ p1: "bytes-one", p2: "bytes-two" })));

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const imageInputs = body.input[0].content.filter((c: any) => c.type === "input_image");
    expect(imageInputs).toHaveLength(2);
    expect(imageInputs[0].image_url).toBe(`data:image/webp;base64,${Buffer.from("bytes-one").toString("base64")}`);
    expect(imageInputs[1].image_url).toBe(`data:image/webp;base64,${Buffer.from("bytes-two").toString("base64")}`);
    expect(imageInputs[0].image_url).not.toMatch(/^https?:\/\//);
  });

  it("skips an unreadable photo file and continues with the remaining usable ones (imagesUsedCount reflects only successes)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(fullFieldResponseBody()));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    const result = await provider.generate(fakeRequest(["p1", "p2"], fakePhotoReader({ p1: new Error("ENOENT"), p2: "bytes-two" })));

    expect(result.metadata.imagesUsedCount).toBe(1);
    expect(result.proposal.suggestedLengthValue).toBe(8.5); // the one surviving image still yields a physical suggestion
  });

  it("omits every physical suggestion when zero photos were usable, even though the model returned physical values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(fullFieldResponseBody()));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    const result = await provider.generate(fakeRequest(["p1"], fakePhotoReader({ p1: new Error("ENOENT") })));

    expect(result.metadata.imagesUsedCount).toBe(0);
    expect(result.proposal.suggestedLengthValue).toBeUndefined();
    expect(result.proposal.suggestedDimensionUnit).toBeUndefined();
    expect(result.proposal.suggestedBrand).toBe("Omega"); // Product Details still generated from text context alone
  });

  it("still generates Product Details/Marketing Tags with no photos at all (empty photo list)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse(fullFieldResponseBody()));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    const result = await provider.generate(fakeRequest([], fakePhotoReader()));
    expect(result.metadata.imagesUsedCount).toBe(0);
    expect(result.proposal.suggestedBrand).toBe("Omega");
  });

  it("maps a 401/403 to CanonicalProductProposalProviderAuthenticationError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse({ error: "unauthorized" }, { status: 401 }));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    await expect(provider.generate(fakeRequest([], fakePhotoReader()))).rejects.toThrow(CanonicalProductProposalProviderAuthenticationError);
  });

  it("maps a network failure to CanonicalProductProposalProviderUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    await expect(provider.generate(fakeRequest([], fakePhotoReader()))).rejects.toThrow(CanonicalProductProposalProviderUnavailableError);
  });

  it("maps an unparsable/invalid model response to CanonicalProductProposalProviderInvalidResponseError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(rawResponse({ output: [] }));
    const provider = new OpenAiCanonicalProductProposalProvider({ apiKey: "key", model: "test-model" });
    await expect(provider.generate(fakeRequest([], fakePhotoReader()))).rejects.toThrow(CanonicalProductProposalProviderInvalidResponseError);
  });
});
