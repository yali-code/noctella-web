import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.postgres";
import { createProductReadServiceContextForDb } from "../src/repositories/product-read/factory";
import { reconcilePublicCart } from "../src/services/cartReconciliation";
import { CheckoutPriceChangedError } from "../src/services/errors";
import { PostgresUnitOfWork } from "../src/services/unitOfWork";
import { createCashOnDeliveryOrderUseCase } from "../src/use-cases/order/useCases";
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

const describePostgres = postgresTestConfigured ? describe : describe.skip;
let harness: PostgresTestDb | undefined;

function product(id: string, priceEur = "125.000000"): typeof schema.products.$inferInsert {
  const timestamp = new Date("2025-07-01T00:00:00.000Z");
  return { id, sku: `S157-${id}`, title: `Sprint 157 ${id}`, wooProductName: `Current ${id}`, slug: `sprint-157-${id}`, type: "unique", status: "published", stockQuantity: 1, priceEur, wooListingPriceEur: priceEur, allowCashOnDelivery: 1, createdAt: timestamp, updatedAt: timestamp };
}

describePostgres("Sprint 157 PostgreSQL cart freshness parity", () => {
  afterEach(async () => { await harness?.close(); harness = undefined; });

  it("reconciles customer-safe current fields through the real PostgreSQL repository", async () => {
    harness = await createPostgresTestDb();
    await harness.db.insert(schema.products).values([product("available"), product("empty", "90.000000")]);
    await harness.db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, "empty"));
    const result = await reconcilePublicCart(harness.db as any, { items: [{ productId: "available", quantity: 1 }, { productId: "empty", quantity: 1 }] }, createProductReadServiceContextForDb(harness.db, "postgres"));
    expect(result.items[0]).toMatchObject({ productId: "available", availability: "available", title: "Current available", priceEur: 125, allowCashOnDelivery: true });
    expect(result.items[0]).not.toHaveProperty("stockQuantity");
    expect(result.items[1]).toEqual({ productId: "empty", availability: "unavailable", reason: "out_of_stock" });
  });

  it("rolls back a final COD price mismatch and preserves the recovery error", async () => {
    harness = await createPostgresTestDb();
    await harness.db.insert(schema.products).values(product("race"));
    const address = { fullName: "Postgres Buyer", line1: "1 Test St", city: "Sofia", postalCode: "1000", country: "BG" };
    const useCase = createCashOnDeliveryOrderUseCase(new PostgresUnitOfWork(harness.db), undefined, undefined, undefined, "postgres");
    await expect(useCase.execute({ orderDraftId: "s157-postgres-race", guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, items: [{ productId: "race", quantity: 1 }], subtotalAmount: 100 })).rejects.toBeInstanceOf(CheckoutPriceChangedError);
    expect(await harness.db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, "s157-postgres-race"))).toHaveLength(0);
    expect((await harness.db.select().from(schema.products).where(eq(schema.products.id, "race")))[0].stockQuantity).toBe(1);
  });
});
