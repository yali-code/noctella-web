// Sprint 141: Unified Channel Selection & Publish - proves the new thin batch orchestration
// (services/marketplacePublishing.ts's executePublishBatch) delegates entirely to the existing,
// unmodified executePublish per channel, attempts every selected channel sequentially regardless
// of an earlier channel's outcome, never rolls back an earlier success, and truthfully classifies
// each channel's outcome (including the non-throwing RetryPending/Failed case and the
// duplicate-active-listing "skipped" mapping). Service-level tests use the same raw-DB +
// injected-MarketplaceAdapter pattern already established in marketplacePublishing.test.ts; a
// separate route-level describe block proves the HTTP-layer permission/request-validation contract
// via supertest against the real app, mirroring marketplacePreparationRouteSprint107.test.ts.
//
// Sprint 146: executePublishBatch now requires an `expectedUpdatedAt` argument (mirrors the
// existing `{channels, expectedUpdatedAt}` request contract) and performs an upfront whole-batch
// Product version precondition, reusing the existing Sprint 88 ProductVersionConflictError,
// checked before any channel is attempted. Every existing call site below is updated to pass the
// real current Product version (captured via `currentVersion`, a thin getProductById wrapper) -
// this is a mechanical, required update to every test in this file, since executePublishBatch's
// contract itself changed; no existing assertion's intent was altered.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { AdminRole, ProductStatus, ProductType, PublishChannel, PublishJobStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { createOAuthState } from "../src/services/oauthState";
import { completeConnect, executePublish, executePublishBatch, listExternalListings } from "../src/services/marketplacePublishing";
import { getProductById } from "../src/services/products";
import { DuplicateActiveListingError, ProductVersionConflictError } from "../src/services/errors";
import type { MarketplaceAdapter } from "../src/services/marketplaceAdapters";

const key = Buffer.alloc(32, 9).toString("base64");
type TestDb = ReturnType<typeof db>;
function db() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }
function future() { return new Date(Date.now() + 100_000).toISOString(); }
function past() { return new Date(Date.now() - 100_000).toISOString(); }
function signedState(channel: PublishChannel) { return createOAuthState(channel, "Default", 60_000); }

/** Sprint 146: the exact current Product.updatedAt - every executePublishBatch call site below must supply this (or a deliberately stale value) as its new required expectedUpdatedAt argument. */
async function currentVersion(database: TestDb, productId: string) {
  return (await getProductById(database as any, productId)).updatedAt;
}

function makeAdapter(overrides: Partial<MarketplaceAdapter> = {}) {
  let createCalls = 0;
  const adapter: MarketplaceAdapter & { createCalls: () => number } = {
    getAuthorizationUrl: (state) => `https://example.test/oauth?state=${state}`,
    exchangeAuthorizationCode: async (code) => ({ accessToken: `access-${code}`, refreshToken: `refresh-${code}`, expiresAt: future(), scopes: ["listings"], externalAccountId: "acct" }),
    refreshAccessToken: async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: future(), scopes: ["listings"] }),
    verifyConnection: async () => ({ externalAccountId: "acct" }),
    createListing: async (_token, payload) => { createCalls += 1; return { externalListingId: `${payload.channel}-${createCalls}`, externalListingUrl: `https://listing.test/${payload.channel}/${createCalls}`, externalStatus: "active", raw: { title: payload.title } }; },
    updateListing: async (_token, id) => ({ externalListingId: id, externalStatus: "active" }),
    endListing: async (_token, id) => ({ externalListingId: id, externalStatus: "ended" }),
    normalizeError: (error) => { const message = error instanceof Error ? error.message : "temporary"; if (message.includes("permanent")) return { type: "Permanent", message: "permanent failed", retryable: false }; return { type: "Temporary", message: "temporary failed", retryable: true }; },
    createCalls: () => createCalls,
    ...overrides,
  };
  return adapter;
}

async function connect(database: TestDb, channel: PublishChannel, adapter = makeAdapter(), expiresAt?: string) {
  const state = signedState(channel);
  await completeConnect(database, channel, "code", state, "", "Default", adapter);
  if (expiresAt) await database.update(schema.marketplaceConnections).set({ tokenExpiresAt: expiresAt }).where(eq(schema.marketplaceConnections.channel, channel));
  return adapter;
}

async function seedEligiblePhoto(database: TestDb, productId: string) {
  const now = new Date().toISOString();
  await database.insert(schema.productPhotos).values({
    id: `ph-${productId}`, productId, url: `/images/product-photos/${productId}.webp`, thumbnailUrl: `/images/product-photos/${productId}-thumb.webp`,
    altText: null, sortOrder: 0, isPrimary: true, filename: `${productId}.webp`, mimeType: "image/webp", sizeBytes: 1024, width: 800, height: 600,
    processingStatus: "Ready", createdAt: now, updatedAt: now,
  } as any);
}

/** A Product publishable on all 3 channels once eBay/Etsy are connected - Sprint 141 extension of marketplacePublishing.test.ts's own product() fixture, adding the Noctella Web fields too. */
async function publishableProduct(database: TestDb, id = "p1", overrides: Record<string, unknown> = {}) {
  await database.insert(schema.products).values({
    id, sku: id, title: "Moon", slug: id, type: "single", status: "approved", stockQuantity: 2, priceEur: 10,
    ebayTitle: "eBay Moon", ebayDescription: "Desc", ebayCategory: "cat", ebayListingPriceEur: 12,
    etsyTitle: "Etsy Moon", etsyDescription: "Desc", etsyTags: JSON.stringify(["tag"]), etsyListingPriceEur: 13,
    wooProductName: "Web Moon", wooShortDescription: "Short", wooLongDescription: "Long description", wooListingPriceEur: 11,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as any);
  await seedEligiblePhoto(database, id);
}

beforeEach(() => {
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = key;
  process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-sprint141";
  vi.restoreAllMocks();
});

describe("executePublishBatch - multi-channel success and ordering", () => {
  it("attempts every selected channel and returns one succeeded result per channel, in request order", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await connect(database, PublishChannel.Etsy, adapter);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy], await currentVersion(database, "p1"), adapter);
    expect(batch.productId).toBe("p1");
    expect(batch.results.map((r) => r.channel)).toEqual([PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]);
    expect(batch.results.every((r) => r.outcome === "succeeded")).toBe(true);
    expect(batch.results[0].result?.job.status).toBe(PublishJobStatus.Succeeded);
  });

  it("executes channels strictly sequentially, never concurrently (no Promise.all)", async () => {
    let activeCount = 0;
    let maxActiveCount = 0;
    const adapter = makeAdapter({
      createListing: async (_token, payload) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeCount -= 1;
        return { externalListingId: `${payload.channel}-x`, externalStatus: "active" };
      },
    });
    const database = db();
    await connect(database, PublishChannel.Ebay, adapter);
    await connect(database, PublishChannel.Etsy, adapter);
    await publishableProduct(database);

    await executePublishBatch(database, "p1", [PublishChannel.Ebay, PublishChannel.Etsy], await currentVersion(database, "p1"), adapter);
    expect(maxActiveCount).toBe(1); // the second channel's adapter call never overlapped the first's
  });
});

describe("executePublishBatch - partial failure and no cross-channel rollback", () => {
  it("Web succeeds, eBay fails (not connected), Etsy is still attempted and succeeds - Web's success is preserved", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Etsy);
    // eBay deliberately never connected.
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy], await currentVersion(database, "p1"), adapter);
    expect(batch.results).toHaveLength(3);
    expect(batch.results[0]).toMatchObject({ channel: PublishChannel.NoctellaWeb, outcome: "succeeded" });
    expect(batch.results[1].channel).toBe(PublishChannel.Ebay);
    expect(batch.results[1].outcome).toBe("failed");
    expect(batch.results[1].error?.message).toMatch(/not connected/);
    expect(batch.results[2]).toMatchObject({ channel: PublishChannel.Etsy, outcome: "succeeded" });

    // No cross-channel rollback: Web's and Etsy's durable effects survive eBay's failure.
    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "p1"));
    expect(productRow.status).toBe("published");
    expect(await listExternalListings(database, "p1")).toHaveLength(1);
  });

  it("an expired eBay connection fails only that channel - later selected channels are still attempted", async () => {
    const database = db();
    await connect(database, PublishChannel.Ebay, makeAdapter(), past());
    const etsyAdapter = await connect(database, PublishChannel.Etsy);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay, PublishChannel.Etsy], await currentVersion(database, "p1"), etsyAdapter);
    expect(batch.results[0]).toMatchObject({ channel: PublishChannel.Ebay, outcome: "failed" });
    expect(batch.results[0].error?.message).toMatch(/expired/);
    expect(batch.results[1]).toMatchObject({ channel: PublishChannel.Etsy, outcome: "succeeded" });
  });

  it("one channel's invalid canonical fields do not block a valid channel, and no marketplace preparation side effect occurs", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Etsy);
    await publishableProduct(database, "p1", { ebayTitle: null, ebayDescription: null, ebayCategory: null, ebayListingPriceEur: null }); // eBay invalid, Etsy still valid

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay, PublishChannel.Etsy], await currentVersion(database, "p1"), adapter);
    expect(batch.results[0]).toMatchObject({ channel: PublishChannel.Ebay, outcome: "failed" });
    expect(batch.results[0].error?.message).toMatch(/validation/i);
    expect(batch.results[1]).toMatchObject({ channel: PublishChannel.Etsy, outcome: "succeeded" });

    // Unified publish never generates/approves marketplace preparation as a side effect.
    const preparations = await database.select().from(schema.marketplacePreparations).where(eq(schema.marketplacePreparations.productId, "p1"));
    expect(preparations).toHaveLength(0);
  });
});

describe("executePublishBatch - non-throwing PublishJob failure is never mislabeled as success", () => {
  it("an adapter failure that executePublish itself catches internally (RetryPending, no thrown exception) is classified as failed, not succeeded", async () => {
    const database = db();
    const failing = makeAdapter({ createListing: async () => { throw new Error("temporary"); } });
    await connect(database, PublishChannel.Ebay, failing);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay], await currentVersion(database, "p1"), failing);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0].outcome).toBe("failed"); // never "succeeded" merely because executePublish resolved
    expect(batch.results[0].result?.job.status).toBe(PublishJobStatus.RetryPending);
    expect(batch.results[0].error?.message).toBeTruthy();
  });

  it("a permanent (non-retryable) adapter failure is also classified as failed with the Failed job status preserved", async () => {
    const database = db();
    const failing = makeAdapter({ createListing: async () => { throw new Error("permanent"); } });
    await connect(database, PublishChannel.Etsy, failing);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Etsy], await currentVersion(database, "p1"), failing);
    expect(batch.results[0].outcome).toBe("failed");
    expect(batch.results[0].result?.job.status).toBe(PublishJobStatus.Failed);
  });
});

describe("executePublishBatch - already-published (duplicate-active-listing) mapping", () => {
  it("a duplicate-active-listing condition maps to 'skipped', and no duplicate ExternalListing is created", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first-manual-publish", adapter); // already published once, outside the batch

    const before = await listExternalListings(database, "p1");
    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay], await currentVersion(database, "p1"), adapter);
    expect(batch.results[0]).toMatchObject({ channel: PublishChannel.Ebay, outcome: "skipped" });
    expect(adapter.createCalls()).toBe(1); // the batch attempt never reached the adapter a second time
    expect(await listExternalListings(database, "p1")).toEqual(before); // no duplicate listing created
  });

  it("an unrelated connection failure (BadRequestError, not a duplicate-listing ConflictError) is never mapped to 'skipped'", async () => {
    const database = db();
    await publishableProduct(database);
    // eBay never connected - a BadRequestError, not the duplicate-active-listing ConflictError.
    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay], await currentVersion(database, "p1"), makeAdapter());
    expect(batch.results[0].outcome).toBe("failed"); // never "skipped" - only the genuine duplicate-active-listing condition maps to skipped
  });

  it("the duplicate-active-listing guard throws the dedicated DuplicateActiveListingError, not the bare ConflictError base class", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first-manual-publish", adapter);
    await expect(executePublish(database, "p1", PublishChannel.Ebay, undefined, adapter)).rejects.toBeInstanceOf(DuplicateActiveListingError);
  });
});

/**
 * Sprint 141 Formal Validation Fix (Required Fix #1): proves that a genuine ConflictError subtype
 * OTHER than the duplicate-active-listing condition - ProductVersionConflictError, reachable through
 * the real Noctella Web execution path (executeNoctellaWebPublish's own updateProduct call, under a
 * concurrent Product write) - is classified as "failed", never "skipped". Uses a deterministic
 * repository-native interception (vi.spyOn the exact seam executeNoctellaWebPublish calls) to
 * reproduce the real production error TYPE without a timing-flaky real concurrency test, mirroring
 * the established pattern from aiSalesPreparationOutboxSprint140.test.ts's own "genuine Admin price
 * race" test. This exercises the ACTUAL batch classification path, not merely
 * `new ProductVersionConflictError(...) instanceof ConflictError` in isolation.
 */
describe("executePublishBatch - unrelated ConflictError (Sprint 141 Formal Validation Required Fix 1)", () => {
  it("a genuine ProductVersionConflictError reaching the batch boundary via the real Noctella Web execution path is classified as failed, never skipped, and attempt-all continues", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database, "p1");
    const version = await currentVersion(database, "p1");
    const productsModule = await import("../src/services/products");
    const conflict = new ProductVersionConflictError("p1", "stale-expected-value", "actual-current-value");
    // Deterministic interception at the exact seam executeNoctellaWebPublish calls
    // (updateProduct(db, productId, {status: Published}) - see marketplacePublishing.ts) -
    // reproduces the real error TYPE a genuine concurrent Product write would cause between
    // updateProductWithInventoryUseCase's internal read and its conditional write. This is
    // deliberately DIFFERENT from the Sprint 146 upfront whole-batch version gate (which compares
    // the batch's own expectedUpdatedAt argument before any channel begins) - this test's version
    // argument matches the real current Product, so the upfront gate passes cleanly, and the
    // conflict this test proves is the pre-existing PER-CHANNEL one raised deeper inside
    // executeNoctellaWebPublish's own write, still reachable and still correctly classified.
    const updateProductSpy = vi.spyOn(productsModule, "updateProduct").mockRejectedValueOnce(conflict);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay], version, adapter);
    expect(updateProductSpy).toHaveBeenCalled();

    expect(batch.results[0].channel).toBe(PublishChannel.NoctellaWeb);
    expect(batch.results[0].outcome).toBe("failed"); // never "skipped"
    expect(batch.results[0].error?.message).not.toMatch(/already/i); // must never claim "already published"
    expect(batch.results[0].error?.message).toBe(conflict.message); // the genuine, safe, recognized ConflictError message

    // Attempt-all: the later selected channel is still attempted despite Web's conflict.
    expect(batch.results[1].channel).toBe(PublishChannel.Ebay);
    expect(batch.results[1].outcome).toBe("succeeded");

    // No false successful Product publication is claimed for the channel that actually conflicted.
    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "p1"));
    expect(productRow.status).not.toBe("published");

    updateProductSpy.mockRestore();
  });
});

/**
 * Sprint 141 Formal Validation Fix (Required Fix #2): proves an unrecognized exception's raw
 * `.message` never reaches the batch response - executePublishBatch catches internally and never
 * re-throws, so routes/errorHandler.ts's own sanitization boundary (which replaces any unrecognized
 * exception with a fixed "Internal server error" string) is never reached for these channel-local
 * errors. A fixed safe fallback must be used instead.
 */
describe("executePublishBatch - unknown exception safety (Sprint 141 Formal Validation Required Fix 2)", () => {
  it("an unrecognized exception's raw message never reaches the batch response - a fixed safe fallback is used instead, and attempt-all continues", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database, "p1");
    const version = await currentVersion(database, "p1");
    const productsModule = await import("../src/services/products");
    const sentinel = new Error("SECRET_INTERNAL_SENTINEL_141 database diagnostics");
    const updateProductSpy = vi.spyOn(productsModule, "updateProduct").mockRejectedValueOnce(sentinel);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay], version, adapter);

    expect(batch.results[0].channel).toBe(PublishChannel.NoctellaWeb);
    expect(batch.results[0].outcome).toBe("failed");
    expect(batch.results[0].error?.message).toBe("Publish failed"); // fixed safe fallback, never the raw message
    expect(JSON.stringify(batch)).not.toContain("SECRET_INTERNAL_SENTINEL_141"); // the sentinel never reaches the response

    // Attempt-all: eBay is still attempted despite Web's unrecognized failure.
    expect(batch.results[1].channel).toBe(PublishChannel.Ebay);
    expect(batch.results[1].outcome).toBe("succeeded");

    updateProductSpy.mockRestore();
  });

  it("recognized safe validation/connection messages remain intact - the Fix 2 fallback only applies to truly unrecognized exceptions", async () => {
    const database = db();
    await publishableProduct(database);
    // eBay never connected - a recognized BadRequestError, its real message must still be exposed.
    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay], await currentVersion(database, "p1"), makeAdapter());
    expect(batch.results[0].outcome).toBe("failed");
    expect(batch.results[0].error?.message).toMatch(/not connected/);
    expect(batch.results[0].error?.message).not.toBe("Publish failed");
  });
});

describe("executePublishBatch - idempotent replay and duplicate-channel request handling", () => {
  it("repeating an unchanged batch call delegates into the existing per-channel idempotency short-circuit - same successful job, no duplicate external publication", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database);
    const version = await currentVersion(database, "p1");

    const first = await executePublishBatch(database, "p1", [PublishChannel.Ebay], version, adapter);
    expect(first.results[0].outcome).toBe("succeeded");
    expect(adapter.createCalls()).toBe(1);

    // No batch-level idempotency key exists, so this second call re-derives executePublish's own
    // default per-channel key from the SAME unchanged payload - it matches the first call's key
    // exactly, hitting the existing idempotency-key short-circuit (returns the same existing
    // Succeeded PublishJob) rather than the duplicate-active-listing guard. Preserves the existing
    // successful/idempotent behavior unmodified, per the locked architecture. eBay/Etsy publication
    // never touches Product.updatedAt (only Noctella Web does), so the same `version` captured
    // before the first call remains the genuine current value for the second call too.
    const second = await executePublishBatch(database, "p1", [PublishChannel.Ebay], version, adapter);
    expect(second.results[0].outcome).toBe("succeeded");
    expect(second.results[0].result?.job.id).toBe(first.results[0].result?.job.id);
    expect(adapter.createCalls()).toBe(1); // the adapter was never invoked a second time
    expect(await listExternalListings(database, "p1")).toHaveLength(1); // no duplicate listing created
  });

  it("duplicate channel values passed to executePublishBatch are deduplicated - one result, one attempt", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay, PublishChannel.Ebay, PublishChannel.Ebay], await currentVersion(database, "p1"), adapter);
    expect(batch.results).toHaveLength(1);
    expect(adapter.createCalls()).toBe(1);
  });
});

/**
 * Sprint 146: the upfront whole-batch Product version precondition - reuses the existing Sprint 88
 * ProductVersionConflictError, checked once (via a fresh getProductById + a plain updatedAt
 * comparison) before any selected channel is attempted. This narrows the exact concurrency gap
 * Sprint 146's architecture identified: without this gate, a stale client could publish a channel
 * using Product field values the admin no longer believes are current.
 */
describe("executePublishBatch - Sprint 146 upfront Product version gate", () => {
  it("a stale expectedUpdatedAt throws the existing ProductVersionConflictError before any channel begins - zero adapter calls, zero new PublishJob/PublishAttempt/ExternalListing rows, no Product mutation", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await connect(database, PublishChannel.Etsy, adapter);
    await publishableProduct(database);
    const before = await getProductById(database as any, "p1");

    await expect(
      executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy], "stale-version-token-not-the-real-value", adapter),
    ).rejects.toBeInstanceOf(ProductVersionConflictError);

    expect(adapter.createCalls()).toBe(0); // zero adapter invocation
    expect(await database.select().from(schema.publishJobs)).toHaveLength(0); // zero new PublishJob
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(0); // zero new PublishAttempt
    expect(await listExternalListings(database, "p1")).toHaveLength(0); // zero new ExternalListing

    const after = await getProductById(database as any, "p1");
    expect(after.status).toBe(before.status); // no Product publication mutation (still not Published)
    expect(after.updatedAt).toBe(before.updatedAt); // the Product row itself was never written to
  });

  it("a matching expectedUpdatedAt (the actual current Product version) permits normal batch execution to proceed exactly as before", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await publishableProduct(database);

    const batch = await executePublishBatch(database, "p1", [PublishChannel.Ebay], await currentVersion(database, "p1"), adapter);
    expect(batch.results[0].outcome).toBe("succeeded");
  });

  it("the version gate is checked before channel iteration even when an earlier channel in the list would otherwise have succeeded", async () => {
    const database = db();
    const adapter = await connect(database, PublishChannel.Ebay);
    await connect(database, PublishChannel.Etsy, adapter);
    await publishableProduct(database);

    // Web would be attempted first per request order and would normally succeed - the stale
    // version must block the ENTIRE batch before Web (or any channel) is ever attempted.
    await expect(
      executePublishBatch(database, "p1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy], "stale-version-token", adapter),
    ).rejects.toBeInstanceOf(ProductVersionConflictError);

    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "p1"));
    expect(productRow.status).not.toBe("published"); // Web's would-be-successful publication never ran
  });
});

describe("POST /api/products/:id/publish/execute-batch - permission and request validation (route level)", () => {
  process.env.DATABASE_URL = ":memory:";
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-unified-publish-route-tests";
  process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
  process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
  process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-unified-publish";

  let app: import("express").Express;
  let appDb: any;
  const PASSWORD = "correct-password-123";
  let ownerCookie: string; // Owner: has products.publish
  let noPermissionCookie: string; // ProductEditor: has products.view/edit but NOT products.publish
  let categoryId: string;
  let skuCounter = 0;

  async function login(email: string): Promise<string> {
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    const setCookie = res.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return String(cookieHeader).split(";")[0];
  }

  async function createTestProduct(): Promise<string> {
    skuCounter += 1;
    const productsModule = await import("../src/services/products");
    const product = await productsModule.createProduct(appDb, {
      sku: `UPB-${skuCounter}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Unified Publish Test Product ${skuCounter}`,
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      priceEur: 500,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
    } as any);
    return product.id;
  }

  /** Sprint 146: the exact current Product.updatedAt via the real service, for route-level requests that must supply the new required expectedUpdatedAt field. */
  async function currentUpdatedAtFor(productId: string): Promise<string> {
    const productsModule = await import("../src/services/products");
    return (await productsModule.getProductById(appDb, productId)).updatedAt;
  }

  beforeAll(async () => {
    const appModule = await import("../src/app");
    app = appModule.default;
    const dbModule = await import("../src/db/client");
    appDb = dbModule.db;
    const adminAuth = await import("../src/services/adminAuth");
    await adminAuth.createAdminUser(appDb, { email: "up-owner@example.com", password: PASSWORD, role: AdminRole.Owner });
    ownerCookie = await login("up-owner@example.com");
    await adminAuth.createAdminUser(appDb, { email: "up-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
    noPermissionCookie = await login("up-editor@example.com");
    const categories = await import("../src/services/categories");
    const category = await categories.createCategory(appDb, { name: "Sprint 141 Route Test Category", displayOrder: 0, isActive: true } as any);
    categoryId = category.id;
  });

  it("rejects an unauthenticated request with 401", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).send({ channels: ["noctella_web"], expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(401);
  });

  it("rejects a request from an admin without products.publish with 403", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", noPermissionCookie).send({ channels: ["noctella_web"], expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(403);
  });

  it("rejects an empty channels array with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: [], expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(400);
  });

  it("rejects a missing channels field with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid PublishChannel value with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["amazon"], expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(400);
  });

  it("rejects a client-supplied idempotencyKey - no batch-level idempotency key exists (unknown field rejected by .strict())", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["noctella_web"], expectedUpdatedAt: await currentUpdatedAtFor(productId), idempotencyKey: "shared-across-channels" });
    expect(res.status).toBe(400);
  });

  // Sprint 146: expectedUpdatedAt is now a required part of the canonical batch request contract.
  it("Sprint 146: rejects a missing expectedUpdatedAt with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["noctella_web"] });
    expect(res.status).toBe(400);
  });

  it("Sprint 146: rejects an empty-string expectedUpdatedAt with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["noctella_web"], expectedUpdatedAt: "" });
    expect(res.status).toBe(400);
  });

  it("Sprint 146: a stale expectedUpdatedAt is rejected with the existing 409 PRODUCT_VERSION_CONFLICT boundary, before any channel is attempted", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["noctella_web"], expectedUpdatedAt: "definitely-not-the-real-current-value" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCT_VERSION_CONFLICT");
  });

  it("accepts a valid request with products.publish and a matching expectedUpdatedAt, returns one result per selected channel, and deduplicates a repeated channel value", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute-batch`).set("Cookie", ownerCookie).send({ channels: ["noctella_web", "noctella_web"], expectedUpdatedAt: await currentUpdatedAtFor(productId) });
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe(productId);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].channel).toBe("noctella_web");
    expect(["succeeded", "failed", "skipped"]).toContain(res.body.results[0].outcome);
  });

  it("returns 404 for a nonexistent product", async () => {
    const res = await request(app).post("/api/products/does-not-exist/publish/execute-batch").set("Cookie", ownerCookie).send({ channels: ["noctella_web"], expectedUpdatedAt: "irrelevant-product-does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("existing single-channel POST /:id/publish/execute remains independently reachable and unaffected", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/publish/execute`).set("Cookie", ownerCookie).send({ channel: "noctella_web" });
    expect(res.status).toBe(400); // validation failure (no price/photo) - proves the OLD route is still wired and still delegates to the same validatePublish, unmodified by Sprint 141/146
    expect(res.body.error).toMatch(/validation/i);
  });
});
