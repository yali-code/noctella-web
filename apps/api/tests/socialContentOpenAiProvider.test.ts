import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestStructuredResponse } from "../src/ai/structuredResponse";
import { createSocialGenerationProvider, type SocialGenerationContext } from "../src/social-content/provider";

vi.mock("../src/ai/structuredResponse", () => ({ requestStructuredResponse: vi.fn() }));
const transport = vi.mocked(requestStructuredResponse);
const context = (): SocialGenerationContext => ({
  product: { id: "p1", sku: "NOC-1", title: "Vintage vase", description: "Stored ERP description", updatedAt: "2026-09-27T10:00:00.000Z" },
  photos: [{ id: "photo1", altText: "Canonical vase description", width: 200, height: 300 }],
  contentType: "post", platform: "instagram", accountLabel: "vault",
});
const output = () => ({ caption: "A vintage vase", hashtags: ["#Vintage"], concept: "Product spotlight", media: [{ photoId: "photo1", editorialAltText: "A vase" }] });
beforeEach(() => {
  vi.stubEnv("SOCIAL_CONTENT_AI_PROVIDER", "openai");
  vi.stubEnv("AI_INTAKE_OPENAI_API_KEY", "fake-test-key");
  vi.stubEnv("AI_INTAKE_OPENAI_MODEL", "test-model");
  transport.mockReset().mockResolvedValue(output());
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real network allowed"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("uses existing transport, canonical metadata and server-owned prompt/model with validated output", async () => {
  const provider = createSocialGenerationProvider();
  expect(provider).toMatchObject({ provider: "openai", model: "test-model", promptVersion: "social-content-v1" });
  expect(await provider.generate(context())).toEqual({ ...output(), hashtags: ["vintage"] });
  expect(transport).toHaveBeenCalledTimes(1);
  const body = transport.mock.calls[0][1] as any;
  expect(body.model).toBe("test-model");
  for (const phrase of ["English", "Instagram", "@noctella.vault", "vintage", "antique", "collectible", "testing status", "working condition", "dates", "materials", "origin", "rarity", "restoration", "supplied eligible photo IDs", "structured output"]) expect(body.instructions).toContain(phrase);
  expect(JSON.parse(body.input[0].content[0].text)).toEqual({ ...context(), product: { id: "p1", sku: "NOC-1", title: "Vintage vase", description: "Stored ERP description" } });
  expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
  expect(JSON.stringify(body)).not.toContain("fake-test-key");
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds whitelisted text and preserves the first ten offered photo IDs without mutating context", async () => {
  const value = context();
  value.product.title = "t".repeat(400); value.product.description = "d".repeat(7000); value.product.sku = "s".repeat(200);
  value.photos = Array.from({ length: 11 }, (_, i) => ({ id: `photo${i + 1}`, altText: "a".repeat(1100), width: 200, height: 300 }));
  const before = structuredClone(value);
  await createSocialGenerationProvider().generate(value);
  const bounded = JSON.parse((transport.mock.calls[0][1] as any).input[0].content[0].text);
  expect(bounded.product.title).toHaveLength(300); expect(bounded.product.description).toHaveLength(6000); expect(bounded.product.sku).toHaveLength(128);
  expect(bounded.photos).toHaveLength(10); expect(bounded.photos[0].altText).toHaveLength(1000);
  expect(bounded.photos.map((p: any) => p.id)).toEqual(value.photos.slice(0, 10).map((p) => p.id));
  expect(value).toEqual(before);
});

it.each([
  null, { ...output(), caption: "x".repeat(2201) }, { ...output(), caption: " " },
  { ...output(), hashtags: Array(11).fill("tag") }, { ...output(), hashtags: ["x".repeat(51)] },
  { ...output(), concept: "x".repeat(1001) }, { ...output(), media: [] },
  { ...output(), media: [{ photoId: "photo1", editorialAltText: "x".repeat(1001) }] },
  { ...output(), media: [{ photoId: "foreign", editorialAltText: "alt" }] },
  { ...output(), aiProvider: "injected" }, { ...output(), requestId: "injected" },
])("rejects invalid, oversized, foreign or provenance-bearing output: %j", async (value) => {
  transport.mockResolvedValue(value);
  await expect(createSocialGenerationProvider().generate(context())).rejects.toThrow("unusable response");
});

it.each([
  ["AI_INTAKE_OPENAI_API_KEY", ""], ["AI_INTAKE_OPENAI_API_KEY", " "],
  ["AI_INTAKE_OPENAI_MODEL", ""], ["AI_INTAKE_OPENAI_MODEL", " "], ["AI_INTAKE_OPENAI_MODEL", "m".repeat(129)],
  ["SOCIAL_CONTENT_AI_PROVIDER", "unknown"],
])("fails closed for invalid configuration %s", (key, value) => {
  vi.stubEnv(key, value);
  expect(() => createSocialGenerationProvider()).toThrow("Social content generation is unavailable");
  expect(transport).not.toHaveBeenCalled();
});

it("keeps the default mock safe without credentials", async () => {
  vi.stubEnv("SOCIAL_CONTENT_AI_PROVIDER", ""); vi.stubEnv("AI_INTAKE_OPENAI_API_KEY", ""); vi.stubEnv("AI_INTAKE_OPENAI_MODEL", "");
  const provider = createSocialGenerationProvider();
  expect(provider.provider).toBe("mock"); await expect(provider.generate(context())).resolves.toMatchObject({ caption: "Vintage vase" });
  expect(transport).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("sanitizes raw transport errors without leaking credentials and allows retry", async () => {
  const provider = createSocialGenerationProvider();
  transport.mockRejectedValueOnce(new Error("raw provider body fake-test-key"));
  try { await provider.generate(context()); throw new Error("Expected failure"); }
  catch (error) { expect(String(error)).toContain("Social content generation is unavailable"); expect(String(error)).not.toMatch(/raw provider|fake-test-key/); }
  await expect(provider.generate(context())).resolves.toMatchObject({ caption: "A vintage vase" });
});
