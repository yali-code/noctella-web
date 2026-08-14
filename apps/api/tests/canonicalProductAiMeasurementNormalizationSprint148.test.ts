// @vitest-environment node
// Sprint 148: pure, network-free tests for the measurement-normalization helpers and the
// physical-suggestion safety net (Architecture Review items E/F/G) - proves 85mm->8.5cm and
// 350g->0.35kg normalization, ambiguous/unsupported unit rejection, negative-value rejection, and
// the "no image -> no physical suggestion" rule, independent of any AI provider or network call.
import { describe, expect, it } from "vitest";
import { normalizeDimensionToCanonical, normalizeWeightToCanonical } from "../src/canonical-product-ai/measurementNormalization";
import { sanitizeCanonicalPhysicalSuggestion, toCanonicalProductProposal } from "../src/canonical-product-ai/openAiOutputSchema";

describe("Sprint 148: measurement normalization", () => {
  it("normalizes 85mm -> 8.5cm", () => {
    expect(normalizeDimensionToCanonical(85, "mm")).toEqual({ value: 8.5, unit: "cm" });
  });

  it("normalizes 350g -> 0.35kg", () => {
    expect(normalizeWeightToCanonical(350, "g")).toEqual({ value: 0.35, unit: "kg" });
  });

  it("passes through an already-canonical cm/kg value unchanged", () => {
    expect(normalizeDimensionToCanonical(12, "cm")).toEqual({ value: 12, unit: "cm" });
    expect(normalizeWeightToCanonical(2, "kg")).toEqual({ value: 2, unit: "kg" });
  });

  it("converts inches/pounds/ounces/meters to their own canonical unit correctly", () => {
    expect(normalizeDimensionToCanonical(1.2, "m")).toEqual({ value: 120, unit: "cm" });
    expect(normalizeDimensionToCanonical(5, "in")).toEqual({ value: 5, unit: "in" });
    expect(normalizeWeightToCanonical(3, "lb")).toEqual({ value: 3, unit: "lb" });
    expect(normalizeWeightToCanonical(16, "oz")).toEqual({ value: 1, unit: "lb" });
  });

  it("rejects a negative value", () => {
    expect(normalizeDimensionToCanonical(-5, "cm")).toBeNull();
    expect(normalizeWeightToCanonical(-1, "kg")).toBeNull();
  });

  it("rejects a non-finite value", () => {
    expect(normalizeDimensionToCanonical(Number.NaN, "cm")).toBeNull();
    expect(normalizeWeightToCanonical(Number.POSITIVE_INFINITY, "kg")).toBeNull();
  });

  it("returns null for an ambiguous/unsupported source unit - never guesses", () => {
    expect(normalizeDimensionToCanonical(5, "furlongs")).toBeNull();
    expect(normalizeWeightToCanonical(5, "stone")).toBeNull();
  });
});

describe("Sprint 148: sanitizeCanonicalPhysicalSuggestion", () => {
  const baseRaw = { lengthValue: null, widthValue: null, heightValue: null, dimensionUnit: null, weightValue: null, weightUnit: null };

  it("omits every physical field when imagesUsedCount is 0 - no image, no physical suggestion", () => {
    const result = sanitizeCanonicalPhysicalSuggestion({ ...baseRaw, lengthValue: 10, dimensionUnit: "cm", weightValue: 1, weightUnit: "kg" }, 0);
    expect(result).toEqual({});
  });

  it("keeps a fully evidenced dimension+weight when at least one image was used", () => {
    const result = sanitizeCanonicalPhysicalSuggestion({ lengthValue: 10, widthValue: 5, heightValue: 2, dimensionUnit: "cm", weightValue: 1, weightUnit: "kg" }, 1);
    expect(result).toEqual({
      suggestedLengthValue: 10,
      suggestedWidthValue: 5,
      suggestedHeightValue: 2,
      suggestedDimensionUnit: "cm",
      suggestedWeightValue: 1,
      suggestedWeightUnit: "kg",
    });
  });

  it("omits a dimension value when dimensionUnit is missing - an incomplete/ambiguous pair is never kept", () => {
    const result = sanitizeCanonicalPhysicalSuggestion({ ...baseRaw, lengthValue: 10, dimensionUnit: null }, 1);
    expect(result.suggestedLengthValue).toBeUndefined();
    expect(result.suggestedDimensionUnit).toBeUndefined();
  });

  it("omits weight when weightUnit is missing", () => {
    const result = sanitizeCanonicalPhysicalSuggestion({ ...baseRaw, weightValue: 5, weightUnit: null }, 1);
    expect(result.suggestedWeightValue).toBeUndefined();
    expect(result.suggestedWeightUnit).toBeUndefined();
  });

  it("omits a negative physical value even when the pair is otherwise complete", () => {
    const result = sanitizeCanonicalPhysicalSuggestion({ ...baseRaw, lengthValue: -3, dimensionUnit: "cm" }, 1);
    expect(result.suggestedLengthValue).toBeUndefined();
  });
});

describe("Sprint 148: toCanonicalProductProposal - full response mapping", () => {
  const fullResponse = {
    suggestedBrand: "Omega",
    suggestedModel: null,
    suggestedManufacturer: null,
    suggestedCountryOfOrigin: null,
    suggestedPeriod: null,
    suggestedMaterials: null,
    suggestedDescription: "  A fine watch.  ",
    suggestedProductStory: null,
    suggestedCondition: null,
    suggestedConditionDescription: null,
    suggestedLengthValue: 10,
    suggestedWidthValue: null,
    suggestedHeightValue: null,
    suggestedDimensionUnit: "cm",
    suggestedWeightValue: null,
    suggestedWeightUnit: null,
    suggestedMarketingTags: ["Father's Day", "Father's Day", "  Vintage  ", ""],
  };

  it("trims text fields and turns blank/null into undefined", () => {
    const proposal = toCanonicalProductProposal(fullResponse, 1);
    expect(proposal.suggestedBrand).toBe("Omega");
    expect(proposal.suggestedDescription).toBe("A fine watch.");
    expect(proposal.suggestedModel).toBeUndefined();
  });

  it("dedupes, trims, and drops empty Marketing Tag suggestions", () => {
    const proposal = toCanonicalProductProposal(fullResponse, 1);
    expect(proposal.suggestedMarketingTags).toEqual(["Father's Day", "Vintage"]);
  });

  it("still omits physical fields when imagesUsedCount is 0, even though text/tag fields survive", () => {
    const proposal = toCanonicalProductProposal(fullResponse, 0);
    expect(proposal.suggestedLengthValue).toBeUndefined();
    expect(proposal.suggestedBrand).toBe("Omega"); // Product Details/Marketing Tags are unaffected by the image-gate.
    expect(proposal.suggestedMarketingTags).toEqual(["Father's Day", "Vintage"]);
  });
});
