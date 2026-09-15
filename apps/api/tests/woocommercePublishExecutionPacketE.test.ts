import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ProductStatus, PublishChannel, PublishJobStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { saveWooCommerceConnection, verifyWooCommerceConnection, type WooCommerceTransport } from "../src/integrations/woocommerce/connectionClient";
import { executePublish, retryPublishJob } from "../src/services/marketplacePublishing";
import { createTestDb } from "./testDb";

const now = "2026-09-14T00:00:00.000Z";
type TestDb = ReturnType<typeof createTestDb>;

function transport(responses: Array<{ status: number; body?: unknown } | Error>) {
  const request = vi.fn(async () => { const response = responses.shift(); if (response instanceof Error) throw response; return response ?? { status: 500 }; });
  return { request } satisfies WooCommerceTransport;
}

async function verifiedConnection(database: TestDb, fake: WooCommerceTransport) {
  await saveWooCommerceConnection(database, { accountLabel: "Default", storeUrl: "https://shop.example.test", consumerKey: "ck_test", consumerSecret: "cs_test" });
  await verifyWooCommerceConnection(database, fake);
  vi.mocked(fake.request).mockClear();
}

async function product(database: TestDb, id = "woo-product", overrides: Record<string, unknown> = {}) {
  await database.insert(schema.products).values({ id, sku: "ART-000001", title: "Moon vase", slug: "moon-vase", type: "unique", status: ProductStatus.Approved, stockQuantity: 3, priceEur: 100, wooProductName: "Woo Moon", wooShortDescription: "Short", wooLongDescription: "Long", wooListingPriceEur: 125, createdAt: now, updatedAt: now, ...overrides } as any);
  await database.insert(schema.productPhotos).values({ id: `photo-${id}`, productId: id, url: "https://cdn.example.test/moon.webp", thumbnailUrl: "https://cdn.example.test/moon-thumb.webp", altText: "Moon vase", sortOrder: 0, isPrimary: true, filename: "moon.webp", mimeType: "image/webp", sizeBytes: 100, width: 800, height: 600, processingStatus: "Ready", createdAt: now, updatedAt: now });
}

beforeEach(() => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); process.env.MARKETPLACE_PUBLISH_MAX_RETRIES = "3"; });

describe("Packet E WooCommerce canonical publish execution", () => {
  it("creates through the injected Packet-D transport and persists canonical success records", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 201, body: { id: 901, permalink: "https://shop.example.test/product/moon", status: "publish" } }]);
    await verifiedConnection(database, fake); await product(database);
    const result = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "woo-create", undefined, fake);
    expect(result.job).toMatchObject({ status: PublishJobStatus.Succeeded, externalListingId: "901", attemptCount: 1 });
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", url: "https://shop.example.test/wp-json/wc/v3/products" }));
    const request = JSON.parse(vi.mocked(fake.request).mock.calls[0]![0].body!);
    expect(request).toMatchObject({ sku: "ART-000001", name: "Woo Moon", regular_price: "125.00", manage_stock: true, stock_quantity: 3 });
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(1);
    expect(await database.select().from(schema.externalListings)).toEqual([expect.objectContaining({ productId: "woo-product", channel: "woocommerce", externalListingId: "901" })]);
  });

  it("updates the existing canonical listing without creating a second remote Product", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 201, body: { id: 901, status: "publish" } }, { status: 200, body: { id: 901, status: "publish" } }]);
    await verifiedConnection(database, fake); await product(database);
    await executePublish(database, "woo-product", PublishChannel.WooCommerce, "woo-create", undefined, fake);
    await database.update(schema.products).set({ wooProductName: "Updated Moon", stockQuantity: 2, updatedAt: "2026-09-14T01:00:00.000Z" }).where(eq(schema.products.id, "woo-product"));
    const updated = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "woo-update", undefined, fake);
    expect(updated.job).toMatchObject({ status: PublishJobStatus.Succeeded, externalListingId: "901" });
    expect(vi.mocked(fake.request).mock.calls.map(([input]) => input.method)).toEqual(["POST", "PUT"]);
    expect(vi.mocked(fake.request).mock.calls[1]![0].url).toBe("https://shop.example.test/wp-json/wc/v3/products/901");
    expect(await database.select().from(schema.externalListings)).toHaveLength(1);
  });

  it("returns the existing successful job on idempotent replay without another transport call", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 201, body: { id: 901, status: "publish" } }]);
    await verifiedConnection(database, fake); await product(database);
    const first = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "same-key", undefined, fake);
    const replay = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "same-key", undefined, fake);
    expect(replay.job.id).toBe(first.job.id); expect(fake.request).toHaveBeenCalledTimes(1);
    expect(await database.select().from(schema.publishJobs)).toHaveLength(1);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(1);
  });

  it("fails validation before transport or canonical publication persistence", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }]); await verifiedConnection(database, fake);
    await database.insert(schema.products).values({ id: "invalid", sku: "SKU", title: "Invalid", slug: "invalid", type: "unique", status: ProductStatus.Approved, stockQuantity: 0, priceEur: null, createdAt: now, updatedAt: now } as any);
    await expect(executePublish(database, "invalid", PublishChannel.WooCommerce, "invalid", undefined, fake)).rejects.toThrow(/validation/i);
    expect(fake.request).not.toHaveBeenCalled(); expect(await database.select().from(schema.publishJobs)).toHaveLength(0); expect(await database.select().from(schema.publishAttempts)).toHaveLength(0);
  });

  it.each([[401, "authentication", PublishJobStatus.Failed], [400, "remote_validation", PublishJobStatus.Failed], [503, "provider", PublishJobStatus.RetryPending]] as const)("persists safe HTTP %s failure classification", async (status, code, expectedStatus) => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status }]); await verifiedConnection(database, fake); await product(database);
    const result = await executePublish(database, "woo-product", PublishChannel.WooCommerce, `failure-${status}`, undefined, fake);
    expect(result.job).toMatchObject({ status: expectedStatus, attemptCount: 1 });
    expect(await database.select().from(schema.publishAttempts)).toEqual([expect.objectContaining({ errorCode: code })]);
    expect(await database.select().from(schema.externalListings)).toHaveLength(0);
  });

  it("records uncertain create transport loss as terminal manual-reconciliation state", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, new Error("response lost with secret")]); await verifiedConnection(database, fake); await product(database);
    const result = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "uncertain-create", undefined, fake);
    expect(result.job).toMatchObject({ status: PublishJobStatus.Failed, attemptCount: 1, lastError: "WooCommerce request timed out or was unavailable" });
    expect(await database.select().from(schema.externalListings)).toHaveLength(0);
  });

  it("retries a definite provider failure and persists one listing and two attempts", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 503 }, { status: 201, body: { id: 902, status: "publish" } }]); await verifiedConnection(database, fake); await product(database);
    const failed = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "retry-create", undefined, fake);
    expect(failed.job.status).toBe(PublishJobStatus.RetryPending);
    const retried = await retryPublishJob(database, failed.job.id, undefined, fake);
    expect(retried.job).toMatchObject({ status: PublishJobStatus.Succeeded, externalListingId: "902", attemptCount: 2 });
    expect(await database.select().from(schema.externalListings)).toHaveLength(1); expect(await database.select().from(schema.publishAttempts)).toHaveLength(2);
  });

  it("stops an uncertain create outcome during retry for manual reconciliation", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 503 }, new Error("response lost")]); await verifiedConnection(database, fake); await product(database);
    const failed = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "retry-then-uncertain", undefined, fake);
    const retried = await retryPublishJob(database, failed.job.id, undefined, fake);
    expect(retried.job).toMatchObject({ status: PublishJobStatus.Failed, attemptCount: 2, lastError: "WooCommerce request timed out or was unavailable" });
    expect(await database.select().from(schema.externalListings)).toHaveLength(0);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(2);
  });

  it("retries updates against the same persisted remote identity", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 201, body: { id: 903, status: "publish" } }, { status: 503 }, { status: 200, body: { id: 903, status: "publish" } }]); await verifiedConnection(database, fake); await product(database);
    await executePublish(database, "woo-product", PublishChannel.WooCommerce, "create", undefined, fake);
    await database.update(schema.products).set({ stockQuantity: 1, updatedAt: "2026-09-14T02:00:00.000Z" }).where(eq(schema.products.id, "woo-product"));
    const failed = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "update-retry", undefined, fake);
    expect(failed.job.status).toBe(PublishJobStatus.RetryPending);
    const retried = await retryPublishJob(database, failed.job.id, undefined, fake);
    expect(retried.job.status).toBe(PublishJobStatus.Succeeded);
    expect(vi.mocked(fake.request).mock.calls.slice(1).map(([input]) => [input.method, input.url])).toEqual([["PUT", "https://shop.example.test/wp-json/wc/v3/products/903"], ["PUT", "https://shop.example.test/wp-json/wc/v3/products/903"]]);
    expect(await database.select().from(schema.externalListings)).toHaveLength(1);
  });

  it("rejects malformed nominal success without persisting false success", async () => {
    const database = createTestDb(), fake = transport([{ status: 200 }, { status: 201, body: { status: "publish" } }]); await verifiedConnection(database, fake); await product(database);
    const result = await executePublish(database, "woo-product", PublishChannel.WooCommerce, "malformed", undefined, fake);
    expect(result.job.status).toBe(PublishJobStatus.Failed);
    expect(await database.select().from(schema.externalListings)).toHaveLength(0);
  });
});
