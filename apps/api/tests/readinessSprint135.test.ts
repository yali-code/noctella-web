import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { ProductStatus, ProductType, ShippingRuleType } from "@noctella/shared";
import { evaluateReadiness } from "../src/use-cases/readiness/useCases";
import { parseConfiguredOrigins } from "../src/auth/originAllowlist";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-135-readiness-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";

let app: import("express").Express;
let db: any;
let getReadiness: any;
let createShippingMethod: any;
let updateShippingMethod: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  ({ getReadiness } = await import("../src/services/readiness"));
  ({ createShippingMethod, updateShippingMethod } = await import("../src/services/shippingMethods"));
});

const savedEnv: Record<string, string | undefined> = {};
function stashEnv(...keys: string[]) {
  for (const key of keys) savedEnv[key] = process.env[key];
}
beforeEach(() => stashEnv("STRIPE_PUBLIC_CHECKOUT_ENABLED", "MOCK_PAYMENTS_ENABLED", "ADMIN_APP_ORIGIN", "STOREFRONT_APP_ORIGIN"));
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("Sprint 135 correction: parseConfiguredOrigins (pure helper, shared by CORS and readiness)", () => {
  it("undefined => no configured origin", () => expect(parseConfiguredOrigins(undefined)).toEqual([]));
  it('"" => no configured origin', () => expect(parseConfiguredOrigins("")).toEqual([]));
  it('"   " => no configured origin', () => expect(parseConfiguredOrigins("   ")).toEqual([]));
  it('",,," => no configured origin', () => expect(parseConfiguredOrigins(",,,")).toEqual([]));
  it('" , , " => no configured origin', () => expect(parseConfiguredOrigins(" , , ")).toEqual([]));
  it('"http://localhost:3001" => one configured origin', () => expect(parseConfiguredOrigins("http://localhost:3001")).toEqual(["http://localhost:3001"]));
  it('" http://localhost:3001 " => one configured origin', () => expect(parseConfiguredOrigins(" http://localhost:3001 ")).toEqual(["http://localhost:3001"]));
  it('"http://localhost:3001, " => one configured origin', () => expect(parseConfiguredOrigins("http://localhost:3001, ")).toEqual(["http://localhost:3001"]));
  it('"http://localhost:3001,http://localhost:3002" => two configured origins', () => expect(parseConfiguredOrigins("http://localhost:3001,http://localhost:3002")).toEqual(["http://localhost:3001", "http://localhost:3002"]));
});

describe("Sprint 135 evaluateReadiness (pure use case)", () => {
  const safeInput = { hasActiveShippingMethod: true, stripePublicCheckoutEnabled: false, mockPaymentsEnabled: false, adminAppOriginConfigured: true, storefrontAppOriginConfigured: true };

  it("1/2. reports not ready when no active shipping method exists (covers both zero-row and inactive-only cases at the pure-logic level)", () => {
    const result = evaluateReadiness({ ...safeInput, hasActiveShippingMethod: false });
    expect(result.ready).toBe(false);
    expect(result.checks.shippingConfigured).toBe(false);
  });

  it("3. reports ready when every check passes", () => {
    const result = evaluateReadiness(safeInput);
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual({ shippingConfigured: true, stripePublicCheckoutDisabled: true, mockPaymentsDisabled: true, adminAppOriginConfigured: true, storefrontAppOriginConfigured: true });
  });

  it("4. reports not ready when Stripe public checkout is enabled", () => {
    const result = evaluateReadiness({ ...safeInput, stripePublicCheckoutEnabled: true });
    expect(result.ready).toBe(false);
    expect(result.checks.stripePublicCheckoutDisabled).toBe(false);
  });

  it("6. reports not ready when mock payments are enabled", () => {
    const result = evaluateReadiness({ ...safeInput, mockPaymentsEnabled: true });
    expect(result.ready).toBe(false);
    expect(result.checks.mockPaymentsDisabled).toBe(false);
  });

  it("7. reports not ready when the Admin origin is not configured", () => {
    const result = evaluateReadiness({ ...safeInput, adminAppOriginConfigured: false });
    expect(result.ready).toBe(false);
    expect(result.checks.adminAppOriginConfigured).toBe(false);
  });

  it("8. reports not ready when the Storefront origin is not configured", () => {
    const result = evaluateReadiness({ ...safeInput, storefrontAppOriginConfigured: false });
    expect(result.ready).toBe(false);
    expect(result.checks.storefrontAppOriginConfigured).toBe(false);
  });

  it("9. the result shape carries only booleans - no environment values, shipping labels, or configuration internals", () => {
    const result = evaluateReadiness(safeInput);
    for (const value of Object.values(result.checks)) expect(typeof value).toBe("boolean");
    expect(Object.keys(result.checks).sort()).toEqual(["adminAppOriginConfigured", "mockPaymentsDisabled", "shippingConfigured", "storefrontAppOriginConfigured", "stripePublicCheckoutDisabled"]);
  });
});

describe("Sprint 135 getReadiness (service, real shipping repository)", () => {
  it("1. zero shipping-method rows => not ready", async () => {
    const result = await getReadiness(db, { ...process.env, STRIPE_PUBLIC_CHECKOUT_ENABLED: undefined, MOCK_PAYMENTS_ENABLED: "false" });
    expect(result.ready).toBe(false);
    expect(result.checks.shippingConfigured).toBe(false);
  });

  it("2. inactive-only shipping methods => not ready", async () => {
    const method = await createShippingMethod(db, { label: "Readiness Inactive", ruleType: ShippingRuleType.Free });
    await updateShippingMethod(db, method.id, { isActive: false });
    const result = await getReadiness(db, { ...process.env, STRIPE_PUBLIC_CHECKOUT_ENABLED: undefined, MOCK_PAYMENTS_ENABLED: "false" });
    expect(result.ready).toBe(false);
    expect(result.checks.shippingConfigured).toBe(false);
  });

  it("5. STRIPE_PUBLIC_CHECKOUT_ENABLED absent/false passes the Stripe check on its own", async () => {
    await createShippingMethod(db, { label: "Readiness Active", ruleType: ShippingRuleType.Free });
    const result = await getReadiness(db, { ...process.env, STRIPE_PUBLIC_CHECKOUT_ENABLED: undefined, MOCK_PAYMENTS_ENABLED: "false" });
    expect(result.checks.stripePublicCheckoutDisabled).toBe(true);
  });
});

describe("Sprint 135 correction: readiness origin normalization matches the real CORS allowlist", () => {
  const safeNonOriginEnv = { STRIPE_PUBLIC_CHECKOUT_ENABLED: undefined, MOCK_PAYMENTS_ENABLED: "false" };

  it("comma-only ADMIN_APP_ORIGIN (\",,,\") is treated as not configured, not merely non-empty after trim", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: ",,,", STOREFRONT_APP_ORIGIN: "http://localhost:3000" });
    expect(result.checks.adminAppOriginConfigured).toBe(false);
    expect(result.ready).toBe(false);
  });

  it("whitespace-and-commas ADMIN_APP_ORIGIN (\" , , \") is treated as not configured", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: " , , ", STOREFRONT_APP_ORIGIN: "http://localhost:3000" });
    expect(result.checks.adminAppOriginConfigured).toBe(false);
  });

  it("comma-only STOREFRONT_APP_ORIGIN (\",,,\") is treated as not configured", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: ",,," });
    expect(result.checks.storefrontAppOriginConfigured).toBe(false);
  });

  it("whitespace-and-commas STOREFRONT_APP_ORIGIN (\" , , \") is treated as not configured", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: " , , " });
    expect(result.checks.storefrontAppOriginConfigured).toBe(false);
  });

  it("a valid origin with a trailing empty segment (\"http://localhost:3001, \") is still configured", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: "http://localhost:3001, ", STOREFRONT_APP_ORIGIN: "http://localhost:3000" });
    expect(result.checks.adminAppOriginConfigured).toBe(true);
  });

  it("a valid multi-origin list is still configured", async () => {
    const result = await getReadiness(db, { ...process.env, ...safeNonOriginEnv, ADMIN_APP_ORIGIN: "http://localhost:3001,http://localhost:3002", STOREFRONT_APP_ORIGIN: "http://localhost:3000" });
    expect(result.checks.adminAppOriginConfigured).toBe(true);
  });
});

describe("Sprint 135 GET /ready and GET /health (HTTP)", () => {
  it("10. GET /health remains an unchanged, unconditional liveness response", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not mutate any state (repeated calls return the same result for the same configuration)", async () => {
    const first = await request(app).get("/ready");
    const second = await request(app).get("/ready");
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  it("returns 503 with a safe not_ready body while mock payments remain enabled (this file's default test env)", async () => {
    // Sprint 135: MOCK_PAYMENTS_ENABLED is deliberately left unset up to this point in the file,
    // so mockPaymentsEnabled() defaults to enabled outside NODE_ENV=production - proving /ready
    // correctly reports not_ready for that reason alone, regardless of shipping-method state.
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.mockPaymentsDisabled).toBe(false);
    for (const value of Object.values(res.body.checks)) expect(typeof value).toBe("boolean");
    expect(JSON.stringify(res.body)).not.toMatch(/sqlite|DATABASE_URL|http:\/\/localhost/i);
  });

  it("returns 200 with a ready body once every condition is satisfied", async () => {
    const { createProduct } = await import("../src/services/products");
    const { createCategory } = await import("../src/services/categories");
    const category = await createCategory(db, { name: "Sprint 135 Readiness HTTP", displayOrder: 0, isActive: true });
    await createProduct(db, { sku: "READY-1", title: "Ready Product", wooProductName: "Ready Product", slug: "ready-product", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, priceEur: 10, wooListingPriceEur: 10, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false });
    await createShippingMethod(db, { label: "Ready HTTP Method", ruleType: ShippingRuleType.Free });
    delete process.env.STRIPE_PUBLIC_CHECKOUT_ENABLED;
    process.env.MOCK_PAYMENTS_ENABLED = "false";
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { shippingConfigured: true, stripePublicCheckoutDisabled: true, mockPaymentsDisabled: true, adminAppOriginConfigured: true, storefrontAppOriginConfigured: true } });
  });
});
