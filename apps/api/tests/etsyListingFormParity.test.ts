// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ListingStatus, ProductStatus, ProductType, PublishChannel, parseEtsyWhenMade } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { productPhotos } from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { buildPublishPreview, validatePublish } from "../src/services/publishing";
import { createProductSchema, updateProductSchema } from "../src/validation/product";
import { createTestDb } from "./testDb";

/**
 * Etsy listing form parity (Phase 1). Synthetic values only - no real shop, profile, manufacturer
 * or compliance data, and no Etsy API call.
 */
const ETSY_COMPLETE = {
  etsyTitle: "Vintage Olympus OM-1 35mm SLR camera body", etsyDescription: "Original camera body, as photographed.",
  etsyTags: ["olympus", "om-1", "film camera"], etsyMaterials: "metal, glass", etsyListingPriceEur: 240,
  etsyTaxonomyId: "1234", etsyShopSectionId: "5678", etsyQuantity: 1, etsySku: "NOC-ETSY-1",
  etsyWhoMade: "someone_else", etsyIsSupply: false, etsyWhenMade: "1970s", etsyVintageYear: 1972,
  etsyShippingProfileId: "1111", etsyProcessingProfileId: "2222", etsyReturnPolicyId: "3333",
  etsyRenewalOption: "manual", etsyFeatured: false, etsyAdsOptIn: false, etsyRestockRequests: false,
  etsyGpsrManufacturerName: "Example Manufacturer Ltd", etsyGpsrManufacturerAddress: "1 Example Street, 10115 Berlin, DE",
  etsyGpsrManufacturerContact: "safety@example.test", etsyGpsrSafetyInformation: "Contains a glass lens; handle with care.",
  etsyConsumerGuaranteeInfo: "Statutory EU legal guarantee applies.",
} as const;
const NEW_FIELDS = Object.keys(ETSY_COMPLETE).filter((k) => !["etsyTitle", "etsyDescription", "etsyTags", "etsyMaterials", "etsyListingPriceEur"].includes(k));

describe("Etsy listing form parity: persistence round-trip and legacy compatibility", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Cameras", displayOrder: 0, isActive: true })).id;
  });
  const base = (overrides: Record<string, unknown> = {}) => ({ sku: "SKU-ETSY-1", title: "Olympus OM-1", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, priceEur: 200, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, ...overrides });

  it("creates, reads and updates every new Etsy field with types preserved", async () => {
    const created = await createProduct(db, createProductSchema.parse(base(ETSY_COMPLETE)) as never);
    const read = await getProductById(db, created.id);
    for (const key of NEW_FIELDS) expect(read[key as keyof typeof read], key).toEqual(ETSY_COMPLETE[key as keyof typeof ETSY_COMPLETE]);
    expect(typeof read.etsyIsSupply).toBe("boolean");
    expect(typeof read.etsyQuantity).toBe("number");
    expect(read.marketplaceReadiness.etsy).toEqual({ ready: true, missingFields: [] });

    const updated = await updateProduct(db, created.id, updateProductSchema.parse({ etsyWhenMade: "1960s", etsyVintageYear: 1965, etsyIsSupply: true, etsyAdsOptIn: true, etsyRenewalOption: "automatic" }) as never);
    expect(updated).toMatchObject({ etsyWhenMade: "1960s", etsyVintageYear: 1965, etsyIsSupply: true, etsyAdsOptIn: true, etsyRenewalOption: "automatic", etsyTaxonomyId: "1234" });
  });

  it("clears a value with null and leaves untouched fields unchanged", async () => {
    const created = await createProduct(db, createProductSchema.parse(base(ETSY_COMPLETE)) as never);
    const updated = await updateProduct(db, created.id, updateProductSchema.parse({ etsyShopSectionId: null, etsyGpsrSafetyInformation: null, etsyFeatured: null }) as never);
    expect(updated.etsyShopSectionId).toBeUndefined();
    expect(updated.etsyGpsrSafetyInformation).toBeUndefined();
    expect(updated.etsyFeatured).toBeUndefined();
    expect(updated.etsyReturnPolicyId).toBe("3333");
  });

  it("legacy products (no new fields) read as unset - never false or zero - and still save as drafts", async () => {
    const legacy = await createProduct(db, base({ etsyTitle: "Legacy", etsyTags: ["a"] }) as never);
    for (const key of NEW_FIELDS) expect(legacy[key as keyof typeof legacy], key).toBeUndefined();
    expect(legacy.marketplaceReadiness.etsy.ready).toBe(false);
    expect(legacy.marketplaceReadiness.etsy.missingFields).toEqual(expect.arrayContaining(["taxonomyId", "whoMade", "whenMade", "shippingProfileId"]));
    // Form-only / unverified Etsy fields never make readiness fail.
    for (const unverified of ["isSupply", "processingProfileId", "returnPolicyId"]) expect(legacy.marketplaceReadiness.etsy.missingFields).not.toContain(unverified);
    // An incomplete or over-limit draft must still save (limits are publish-time only).
    const draft = await updateProduct(db, legacy.id, updateProductSchema.parse({ etsyTitle: "x".repeat(200), etsyTags: Array.from({ length: 20 }, (_, i) => `tag-${i}`), etsyWhoMade: "i_did" }) as never);
    expect(draft.etsyTitle).toHaveLength(200);
    expect(draft.etsyTags).toHaveLength(20);
  });

  it("does not change eBay or Noctella Web readiness", async () => {
    const product = await createProduct(db, base({ ...ETSY_COMPLETE, ebayTitle: "eBay", ebayDescription: "d", ebayCategory: "c", ebayListingPriceEur: 10, wooProductName: "w", wooShortDescription: "s", wooListingPriceEur: 10 }) as never);
    expect(product.marketplaceReadiness.ebay).toEqual({ ready: true, missingFields: [] });
    expect(product.marketplaceReadiness.woocommerce).toEqual({ ready: true, missingFields: [] });
  });
});

describe("Etsy listing form parity: draft-save structural validation", () => {
  const minimal = { sku: "S", title: "T", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: "c" };
  const ok = (extra: Record<string, unknown>) => createProductSchema.safeParse({ ...minimal, ...extra }).success;
  const message = (extra: Record<string, unknown>) => { const r = createProductSchema.safeParse({ ...minimal, ...extra }); return r.success ? null : r.error.issues[0]!.message; };

  it("accepts valid values and every documented when_made shape", () => {
    expect(ok(ETSY_COMPLETE)).toBe(true);
    for (const etsyWhenMade of ["made_to_order", "2020_2026", "2010_2019", "before_2007", "1990s", "1800s", "1700s", "before_1700"]) expect(ok({ etsyWhenMade }), etsyWhenMade).toBe(true);
    expect(ok({ etsyGpsrManufacturerContact: "https://example.test/safety" })).toBe(true);
  });

  it.each([
    [{ etsyTaxonomyId: "abc" }, "Etsy category (taxonomy) ID must be a positive whole number"],
    [{ etsyShippingProfileId: "0" }, "Etsy shipping profile ID must be a positive whole number"],
    [{ etsyReturnPolicyId: "-5" }, "Etsy return policy ID must be a positive whole number"],
    [{ etsyWhoMade: "my_cat" }, null],
    [{ etsyWhenMade: "the seventies" }, "When was it made must be made_to_order, a decade (e.g. 1970s), a year range (e.g. 2020_2026) or before_YYYY"],
    [{ etsyWhenMade: "2026_2020" }, null],
    [{ etsyQuantity: 0 }, "Etsy quantity must be at least 1"],
    [{ etsyQuantity: 1000 }, "Etsy quantity cannot exceed 999"],
    [{ etsyQuantity: 1.5 }, "Etsy quantity must be a whole number"],
    [{ etsyVintageYear: 3000 }, "Vintage year cannot be in the future"],
    [{ etsyWhenMade: "1970s", etsyVintageYear: 1985 }, "Vintage year must fall within the selected 'When was it made' period"],
    [{ etsyWhenMade: "made_to_order", etsyVintageYear: 1985 }, "Vintage year must fall within the selected 'When was it made' period"],
    [{ etsyRenewalOption: "sometimes" }, null],
    [{ etsyGpsrManufacturerContact: "call us" }, "GPSR contact must be an email address or an https:// URL"],
    [{ etsyGpsrResponsiblePersonContact: "http://example.test" }, "GPSR contact must be an email address or an https:// URL"],
    [{ etsyAdsOptIn: "yes" }, null],
  ])("rejects %j", (extra, expected) => {
    expect(ok(extra)).toBe(false);
    if (expected) expect(message(extra)).toBe(expected);
  });

  it("applies the vintage-year rule on partial updates too", () => {
    expect(updateProductSchema.safeParse({ etsyWhenMade: "1800s", etsyVintageYear: 1850 }).success).toBe(true);
    expect(updateProductSchema.safeParse({ etsyWhenMade: "1800s", etsyVintageYear: 1950 }).success).toBe(false);
  });

  it("parses when_made spans for consistency checks", () => {
    expect(parseEtsyWhenMade("1970s")).toEqual({ kind: "decade", fromYear: 1970, toYear: 1979 });
    expect(parseEtsyWhenMade("1800s")).toEqual({ kind: "decade", fromYear: 1800, toYear: 1899 });
    expect(parseEtsyWhenMade("before_2007")).toEqual({ kind: "before", fromYear: null, toYear: 2006 });
  });
});

describe("Etsy listing form parity: publish gate (no Etsy API call)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Cameras", displayOrder: 0, isActive: true })).id;
  });
  async function product(overrides: Record<string, unknown> = {}, stockQuantity = 1) {
    const unique = Math.random().toString(36).slice(2, 8);
    const created = await createProduct(db, { sku: `SKU-${unique}`, title: `Olympus OM-1 ${unique}`, type: stockQuantity > 1 ? ProductType.LotItem : ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, priceEur: 200, stockQuantity, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, ...ETSY_COMPLETE, ...overrides } as never);
    await db.insert(productPhotos).values({ id: `ph-${created.id}`, productId: created.id, url: "/images/product-photos/x.webp", thumbnailUrl: "/images/product-photos/x-thumb.webp", altText: null, sortOrder: 0, isPrimary: true, filename: "x.webp", mimeType: "image/webp", sizeBytes: 10, width: 1200, height: 1200, processingStatus: "Ready" } as never);
    return getProductById(db, created.id);
  }
  const errorsOf = (p: Awaited<ReturnType<typeof product>>) => validatePublish(p, PublishChannel.Etsy).errors.map((e) => e.field);

  it("an Etsy-complete product is publishable; GPSR responsible person absence alone is not an error", async () => {
    const v = validatePublish(await product(), PublishChannel.Etsy);
    expect(v).toMatchObject({ valid: true, errors: [] });
  });

  it("blocks only on Etsy API-required fields; form-only fields are warnings that never block", async () => {
    const p = await product({ etsyTaxonomyId: null, etsyWhoMade: null, etsyIsSupply: null, etsyWhenMade: null, etsyVintageYear: null, etsyShippingProfileId: null, etsyProcessingProfileId: null, etsyReturnPolicyId: null });
    expect(errorsOf(p)).toEqual(["etsyTaxonomyId", "etsyWhoMade", "etsyWhenMade", "etsyShippingProfileId"]);
    const v = validatePublish(p, PublishChannel.Etsy);
    expect(v.warnings.filter((w) => w.type === "missing_required_field").map((w) => w.field)).toEqual(["etsyIsSupply", "etsyProcessingProfileId", "etsyReturnPolicyId"]);
    const onlyUnverifiedMissing = await product({ etsyIsSupply: null, etsyProcessingProfileId: null, etsyReturnPolicyId: null });
    expect(validatePublish(onlyUnverifiedMissing, PublishChannel.Etsy)).toMatchObject({ valid: true, errors: [] });
    expect(onlyUnverifiedMissing.marketplaceReadiness.etsy).toEqual({ ready: true, missingFields: [] });
  });

  it("blocks on verified title/tag limits and warns on unverified material/SKU limits", async () => {
    const p = await product({ etsyTitle: "x".repeat(141), etsyTags: [...Array.from({ length: 13 }, (_, i) => `t${i}`), "one-too-many"], etsyMaterials: Array.from({ length: 14 }, (_, i) => `m${i}`).join(", "), etsySku: "S".repeat(33) });
    const issues = validatePublish(p, PublishChannel.Etsy).errors.filter((e) => e.type === "marketplace_limit_exceeded").map((e) => e.message);
    expect(issues).toEqual(["Etsy title must be at most 140 characters", "Etsy allows at most 13 tags"]);
    const unverified = validatePublish(p, PublishChannel.Etsy).warnings.filter((w) => w.type === "marketplace_limit_exceeded").map((w) => w.field);
    expect(unverified).toEqual(["etsyMaterials", "etsySku"]);
    expect(validatePublish(await product({ etsyMaterials: Array.from({ length: 14 }, (_, i) => `m${i}`).join(", "), etsySku: "S".repeat(33) }), PublishChannel.Etsy).valid).toBe(true);
    expect(errorsOf(await product({ etsyTags: ["a".repeat(21)] }))).toContain("etsyTags");
  });

  it("never offers more on Etsy than the ERP stock", async () => {
    expect(errorsOf(await product({ etsyQuantity: 2 }, 1))).toContain("etsyQuantity");
    expect(errorsOf(await product({ etsyQuantity: 3 }, 3))).not.toContain("etsyQuantity");
  });

  it("warns (does not block) when an item made by someone else is not vintage and not a supply", async () => {
    const warned = (p: Awaited<ReturnType<typeof product>>) => validatePublish(p, PublishChannel.Etsy).warnings.filter((w) => w.type === "invalid_marketplace_value").map((w) => w.field);
    const recent = await product({ etsyWhenMade: "2020_2026", etsyVintageYear: null });
    expect(warned(recent)).toEqual(["etsyWhenMade"]);
    expect(validatePublish(recent, PublishChannel.Etsy).valid).toBe(true);
    expect(warned(await product({ etsyWhenMade: "made_to_order", etsyVintageYear: null }))).toEqual(["etsyWhenMade"]);
    expect(warned(await product({ etsyWhenMade: "2020_2026", etsyVintageYear: null, etsyIsSupply: true }))).toEqual([]);
    expect(warned(await product({ etsyWhoMade: "i_did", etsyWhenMade: "2020_2026", etsyVintageYear: null }))).toEqual([]);
    expect(warned(await product())).toEqual([]);
  });

  it("warns (never enables) Etsy Ads and flags missing or incomplete GPSR information without inventing it", async () => {
    const ads = validatePublish(await product({ etsyAdsOptIn: true }), PublishChannel.Etsy);
    expect(ads.valid).toBe(true);
    expect(ads.warnings.map((w) => w.field)).toContain("etsyAdsOptIn");
    const none = validatePublish(await product({ etsyGpsrManufacturerName: null, etsyGpsrManufacturerAddress: null, etsyGpsrManufacturerContact: null }), PublishChannel.Etsy);
    expect(none.warnings.find((w) => w.field === "etsyGpsrManufacturerName")?.message).toMatch(/not provided/);
    const partial = validatePublish(await product({ etsyGpsrManufacturerAddress: null }), PublishChannel.Etsy);
    expect(partial.warnings.find((w) => w.field === "etsyGpsrManufacturerName")?.message).toMatch(/incomplete/);
    expect(partial.valid).toBe(true);
  });

  it("does not add any Phase 1 field to the Etsy payload, and leaves eBay and Noctella Web validation unchanged", async () => {
    const p = await product({ ebayTitle: "e", ebayDescription: "d", ebayCategory: "c", ebayListingPriceEur: 10, ebayListingStatus: ListingStatus.Draft, wooProductName: "w", wooShortDescription: "s", wooLongDescription: "l", wooListingPriceEur: 10, etsyTaxonomyId: null });
    const etsy = JSON.stringify(buildPublishPreview({ ...p, etsyTaxonomyId: "1234" }, PublishChannel.Etsy).payload);
    for (const key of ["taxonomy", "whoMade", "who_made", "whenMade", "Gpsr", "ShippingProfile", "Ads", "Renewal"]) expect(etsy).not.toContain(key);
    expect(validatePublish(p, PublishChannel.Ebay).valid).toBe(true);
    expect(validatePublish(p, PublishChannel.NoctellaWeb).valid).toBe(true);
    expect(validatePublish(p, PublishChannel.Etsy).valid).toBe(false);
  });
});

describe("Etsy listing form parity: additive migrations", () => {
  const NEW_COLUMNS = ["etsy_taxonomy_id", "etsy_shop_section_id", "etsy_quantity", "etsy_sku", "etsy_who_made", "etsy_is_supply", "etsy_when_made", "etsy_vintage_year",
    "etsy_shipping_profile_id", "etsy_processing_profile_id", "etsy_return_policy_id", "etsy_renewal_option", "etsy_featured", "etsy_ads_opt_in", "etsy_restock_requests",
    "etsy_gpsr_manufacturer_name", "etsy_gpsr_manufacturer_address", "etsy_gpsr_manufacturer_contact", "etsy_gpsr_responsible_person_name",
    "etsy_gpsr_responsible_person_address", "etsy_gpsr_responsible_person_contact", "etsy_gpsr_safety_information", "etsy_consumer_guarantee_info"];
  const productColumns = (sqlite: Database.Database) => (sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name);

  it("SQLite: a pre-change database gains the columns, keeps its rows with NULLs, and re-running is a no-op", () => {
    const schemaSql = fs.readFileSync(path.resolve(__dirname, "../src/db/schema.sql"), "utf8");
    // Reconstruct the exact pre-change schema by removing this change's column block.
    const preChange = schemaSql.replace(new RegExp(`^\\s*(--[^\\n]*(Etsy listing form parity|physical column order)[^\\n]*|(${NEW_COLUMNS.join("|")}) [A-Z]+,)\\r?\\n`, "gm"), "");
    const sqlite = new Database(":memory:");
    sqlite.exec(preChange);
    expect(productColumns(sqlite).some((c) => NEW_COLUMNS.includes(c))).toBe(false);
    sqlite.prepare("INSERT INTO categories (id, name, slug) VALUES ('c1', 'Cameras', 'cameras')").run();
    sqlite.prepare("INSERT INTO products (id, sku, title, slug, type, status, category_id, etsy_title, etsy_tags) VALUES ('p1', 'LEGACY-1', 'Legacy', 'legacy', 'unique_item', 'draft', 'c1', 'Legacy Etsy', '[\"a\"]')").run();
    ensureSchema(sqlite);
    const after = productColumns(sqlite);
    for (const column of NEW_COLUMNS) expect(after, column).toContain(column);
    const row = sqlite.prepare(`SELECT sku, etsy_title, etsy_tags, ${NEW_COLUMNS.join(", ")} FROM products WHERE id = 'p1'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ sku: "LEGACY-1", etsy_title: "Legacy Etsy", etsy_tags: "[\"a\"]" });
    for (const column of NEW_COLUMNS) expect(row[column], column).toBeNull();
    ensureSchema(sqlite);
    expect(productColumns(sqlite)).toEqual(after);
  });

  it("SQLite: a fresh database has the columns in the same order as an ALTER-migrated one", () => {
    const fresh = new Database(":memory:");
    ensureSchema(fresh);
    const columns = productColumns(fresh);
    expect(columns.slice(columns.indexOf("updated_at") + 1)).toEqual(NEW_COLUMNS);
  });

  it("PostgreSQL: migration 0039 only adds the same nullable columns (no drop, update, default or backfill)", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../src/db/postgres-migrations/0039_etsy_listing_form_parity.sql"), "utf8");
    const statements = sql.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("--"));
    expect(statements).toHaveLength(NEW_COLUMNS.length);
    expect(statements.map((s) => /^ALTER TABLE products ADD COLUMN IF NOT EXISTS (\w+) (text|integer|boolean);$/.exec(s)?.[1])).toEqual(NEW_COLUMNS);
    expect(statements.join(" ")).not.toMatch(/DROP|UPDATE|DEFAULT|NOT NULL/i);
  });
});
