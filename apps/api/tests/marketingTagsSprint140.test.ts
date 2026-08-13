import { beforeEach, describe, expect, it } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import {
  addProductMarketingTag,
  applyAiSuggestedMarketingTagsIfProductHasNone,
  canonicalizeMarketingTagKey,
  listProductMarketingTags,
  removeProductMarketingTag,
} from "../src/services/marketingTags";
import { NotFoundError } from "../src/services/errors";
import { createTestDb } from "./testDb";

/**
 * Sprint 140: Marketing Tag canonicalization - the exact worked examples from Architecture
 * Review must all converge to the same canonical key.
 */
describe("canonicalizeMarketingTagKey (Sprint 140)", () => {
  it("converges Father's Day / Fathers day / father's-day to the same canonical key", () => {
    expect(canonicalizeMarketingTagKey("Father's Day")).toBe("fathers-day");
    expect(canonicalizeMarketingTagKey("Fathers day")).toBe("fathers-day");
    expect(canonicalizeMarketingTagKey("father’s-day")).toBe("fathers-day");
  });

  it("lowercases and trims", () => {
    expect(canonicalizeMarketingTagKey("  Christmas  ")).toBe("christmas");
  });

  it("strips accents via NFKD normalization", () => {
    expect(canonicalizeMarketingTagKey("Café Gift")).toBe("cafe-gift");
  });

  it("collapses punctuation/whitespace runs to a single hyphen", () => {
    expect(canonicalizeMarketingTagKey("Gift   for -- Him!!")).toBe("gift-for-him");
  });

  it("rejects a canonical key that would be empty", () => {
    expect(canonicalizeMarketingTagKey("   ")).toBeNull();
    expect(canonicalizeMarketingTagKey("''")).toBeNull();
    expect(canonicalizeMarketingTagKey("---")).toBeNull();
  });
});

describe("Marketing Tag repository/service (Sprint 140)", () => {
  let db: ReturnType<typeof createTestDb>;
  let productId: string;
  let otherProductId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Test Category", displayOrder: 0, isActive: true });
    const baseInput = {
      sku: "SKU-MTAG-001",
      title: "Test Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
    };
    const product = await createProduct(db, baseInput as any);
    productId = product.id;
    const otherProduct = await createProduct(db, { ...baseInput, sku: "SKU-MTAG-002", title: "Other Test Product" } as any);
    otherProductId = otherProduct.id;
  });

  it("adding a tag canonicalizes the label server-side and is idempotent", async () => {
    const first = await addProductMarketingTag(db, productId, "Father's Day");
    expect(first.key).toBe("fathers-day");
    expect(first.label).toBe("Father's Day");

    const second = await addProductMarketingTag(db, productId, "father’s-day"); // a spelling variant of the same tag
    expect(second.key).toBe("fathers-day");
    expect(second.id).toBe(first.id); // find-or-create resolved to the SAME canonical tag row

    const tags = await listProductMarketingTags(db, productId);
    expect(tags).toHaveLength(1); // the relation itself is also idempotent - no duplicate relation row
  });

  it("rejects a label whose canonical key would be empty", async () => {
    await expect(addProductMarketingTag(db, productId, "   ")).rejects.toThrow();
  });

  it("the canonical marketing_tags key is unique across Products - a second Product reuses the same tag row", async () => {
    const a = await addProductMarketingTag(db, productId, "Christmas");
    const b = await addProductMarketingTag(db, otherProductId, "christmas");
    expect(a.id).toBe(b.id);
  });

  it("list returns exactly the tags related to that Product, not another Product's tags", async () => {
    await addProductMarketingTag(db, productId, "Christmas");
    await addProductMarketingTag(db, otherProductId, "Birthday Gift");
    const tags = await listProductMarketingTags(db, productId);
    expect(tags.map((t) => t.key)).toEqual(["christmas"]);
  });

  it("remove removes only the one Product/tag relation - the global tag row and other Products' relations survive", async () => {
    const tag = await addProductMarketingTag(db, productId, "Christmas");
    await addProductMarketingTag(db, otherProductId, "Christmas");

    await removeProductMarketingTag(db, productId, tag.id);

    expect(await listProductMarketingTags(db, productId)).toHaveLength(0);
    expect(await listProductMarketingTags(db, otherProductId)).toHaveLength(1); // the other Product's relation is untouched
  });

  it("removing a relation that does not exist throws NotFoundError, never a silent success", async () => {
    await expect(removeProductMarketingTag(db, productId, "not-a-real-tag-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  describe("applyAiSuggestedMarketingTagsIfProductHasNone - the locked ownership rule", () => {
    it("AI initial write occurs when the Product has zero tags", async () => {
      await applyAiSuggestedMarketingTagsIfProductHasNone(db, productId, ["Father's Day", "Watch Collector"]);
      const tags = await listProductMarketingTags(db, productId);
      expect(tags.map((t) => t.key).sort()).toEqual(["fathers-day", "watch-collector"]);
    });

    it("deduplicates spelling variants arriving in one AI response into a single tag", async () => {
      await applyAiSuggestedMarketingTagsIfProductHasNone(db, productId, ["Father's Day", "Fathers day", "father's-day"]);
      const tags = await listProductMarketingTags(db, productId);
      expect(tags).toHaveLength(1);
      expect(tags[0].key).toBe("fathers-day");
    });

    it("skips entirely once ANY tag already exists on the Product - ordinary automatic retry never touches an Admin-owned set", async () => {
      await addProductMarketingTag(db, productId, "Vintage Gift"); // Admin-added
      await applyAiSuggestedMarketingTagsIfProductHasNone(db, productId, ["Christmas", "Birthday Gift"]);
      const tags = await listProductMarketingTags(db, productId);
      expect(tags.map((t) => t.key)).toEqual(["vintage-gift"]); // AI suggestions were never applied
    });

    it("an empty or fully-unusable suggestion list writes nothing and does not throw", async () => {
      await expect(applyAiSuggestedMarketingTagsIfProductHasNone(db, productId, [])).resolves.toBeUndefined();
      await expect(applyAiSuggestedMarketingTagsIfProductHasNone(db, productId, ["   ", "''"])).resolves.toBeUndefined();
      expect(await listProductMarketingTags(db, productId)).toHaveLength(0);
    });
  });
});
