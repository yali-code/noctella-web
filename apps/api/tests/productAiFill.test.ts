import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { createCategory } from "../src/services/categories";
import { listProductMarketingTags } from "../src/services/marketingTags";
import { fillProductWithAi } from "../src/services/productAiFill";
import { createProduct } from "../src/services/products";
import { buildProductAiFillJsonSchema, buildProductAiFillPrompt, PRODUCT_AI_FILL_TEXT_FIELDS, type ProductAiFillResult } from "../src/product-ai-fill/contract";
import { mapProductAiFillToProductValues } from "../src/use-cases/product-ai-fill/useCases";

const result = {
  ...Object.fromEntries(PRODUCT_AI_FILL_TEXT_FIELDS.map((field) => [field, `AI ${field}`])),
  priceEur: 100, priceUsd: 110, minOfferPrice: 80, keywords: ["camera", "camera"], etsyTags: ["camera", "x".repeat(21)], marketingTags: ["Gift"],
} as ProductAiFillResult;

describe("product AI fill", () => {
  it("requires every field and never asks for owner-controlled fields", () => {
    const schema = buildProductAiFillJsonSchema();
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["manufacturer", "priceEur", "minOfferPrice", "ebayTitle", "etsyMaterials", "wooProductName"]));
    for (const field of ["condition", "stockQuantity", "purchaseCost", "internalNotes", "lengthValue", "weightValue", "status", "sku"]) {
      expect(schema.properties).not.toHaveProperty(field);
    }
  });

  it("fills blank fields and keeps existing values by default", () => {
    const values = mapProductAiFillToProductValues({ id: "p", brand: "Panasonic", priceEur: 50 } as any, result, false);
    expect(values.brand).toBeUndefined();
    expect(values.priceEur).toBeUndefined();
    expect(values.manufacturer).toBe("AI manufacturer");
    expect(values.keywords).toBe(JSON.stringify(["camera"]));
    expect(values.etsyTags).toBe(JSON.stringify(["camera"]));
  });

  it("replace mode changes text but never prices or the warehouse note", () => {
    const values = mapProductAiFillToProductValues({ id: "p", brand: "Old", priceEur: 50, priceUsd: 55, minOfferPrice: 40, conditionDescription: "Tested, not working" } as any, result, true);
    expect(values.brand).toBe("AI brand");
    for (const key of ["priceEur", "priceUsd", "minOfferPrice", "conditionDescription"]) expect(values[key]).toBeUndefined();
  });

  it("drops a minimum offer above the price and enforces the eBay title limit", () => {
    const values = mapProductAiFillToProductValues({ id: "p", priceEur: 50 } as any, { ...result, ebayTitle: "t".repeat(90) }, false);
    expect(values.minOfferPrice).toBeUndefined();
    expect(String(values.ebayTitle)).toHaveLength(80);
  });

  it("gives the AI the working-state rule and warehouse facts", () => {
    const { systemPrompt, userPrompt } = buildProductAiFillPrompt({ title: "Camera", condition: "For parts", conditionDescription: "Not working", known: {}, photos: [] });
    expect(systemPrompt).toContain("write that functionality was not tested");
    expect(systemPrompt).toContain("Fill every field");
    expect(userPrompt).toContain("Warehouse condition: For parts");
    expect(userPrompt).toContain("Warehouse condition note: Not working");
  });
});

describe("fillProductWithAi", () => {
  it("makes one provider call, fills the product and tags, and leaves condition, stock and status unchanged", async () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const db = drizzle(sqlite, { schema: sqliteSchema }) as any;
    const category = await createCategory(db, { name: "Cameras", displayOrder: 0, isActive: true } as any);
    const product = await createProduct(db, { sku: "NOC-T1", title: "Camera", slug: "camera", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, stockQuantity: 1, condition: "For parts", conditionDescription: "Not working" } as any);
    const provider = { fill: vi.fn(async () => result) };

    const filled = await fillProductWithAi(db, product.id, false, provider);

    expect(provider.fill).toHaveBeenCalledTimes(1);
    expect(filled.manufacturer).toBe("AI manufacturer");
    expect(filled.priceEur).toBe(100);
    expect(filled.ebayTitle).toBe("AI ebayTitle");
    expect(filled.etsyMaterials).toBe("AI etsyMaterials");
    expect(filled.wooProductName).toBe("AI wooProductName");
    expect(filled.condition).toBe("For parts");
    expect(filled.conditionDescription).toBe("Not working");
    expect(filled.stockQuantity).toBe(product.stockQuantity);
    expect(filled.status).toBe(ProductStatus.Draft);
    expect((await listProductMarketingTags(db, product.id)).map((tag) => tag.label)).toEqual(["Gift"]);
  });
});
