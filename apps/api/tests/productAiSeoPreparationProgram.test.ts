import { describe, expect, it } from "vitest";
import { prepareOptionalProductSeo } from "../src/integrations/productAiSeoPreparation";

const product = { title: "Moon vase", description: "Canonical description" } as any;

describe("optional AI and SEO preparation", () => {
  it("preserves manually authored SEO over a proposal", () => {
    const prepared = prepareOptionalProductSeo(
      { ...product, seoTitle: "Manual title", metaDescription: "Manual summary", keywords: [" manual "] },
      { seoTitle: "AI title", metaDescription: "AI summary", keywords: ["ai"] },
    );
    expect(prepared).toMatchObject({ seoTitle: "Manual title", metaDescription: "Manual summary", keywords: ["manual"] });
    expect(prepared.source).toEqual({ seoTitle: "manual", metaDescription: "manual", keywords: "manual" });
  });

  it("accepts optional proposals without mutating Product", () => {
    const proposal = { seoTitle: "AI title", metaDescription: "AI summary", keywords: ["vintage", " vase "] };
    expect(prepareOptionalProductSeo(product, proposal)).toMatchObject({ seoTitle: "AI title", metaDescription: "AI summary", keywords: ["vintage", "vase"] });
    expect(product).not.toHaveProperty("seoTitle");
  });

  it("falls back deterministically to canonical content when AI is absent", () => {
    expect(prepareOptionalProductSeo(product)).toEqual({
      seoTitle: "Moon vase",
      metaDescription: "Canonical description",
      keywords: [],
      source: { seoTitle: "canonical", metaDescription: "canonical", keywords: "canonical" },
    });
  });
});
