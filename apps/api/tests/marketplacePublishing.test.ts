import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { MarketplaceConnectionStatus, PublishChannel, PublishJobStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { decryptCredential, encryptCredential } from "../src/services/credentialEncryption";
import { ConflictError } from "../src/services/errors";
import { createOAuthState } from "../src/services/oauthState";
import { completeConnect, disconnect, endExternalListing, executePublish, getPublishJob, listConnections, listExternalListings, listPublishJobs, refreshConnection, retryPublishJob, sanitizeMarketplaceError, startConnect, verifyConnection } from "../src/services/marketplacePublishing";
import { buildPublishPayload } from "../src/services/publishing";
import type { MarketplaceAdapter } from "../src/services/marketplaceAdapters";

const key = Buffer.alloc(32, 7).toString("base64");
type TestDb = ReturnType<typeof db>;
function db() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }
function future() { return new Date(Date.now() + 100_000).toISOString(); }
function past() { return new Date(Date.now() - 100_000).toISOString(); }
function signedState(channel: PublishChannel = PublishChannel.Ebay) { return createOAuthState(channel, "Default", 60_000); }
function makeAdapter(overrides: Partial<MarketplaceAdapter> = {}) {
  let createCalls = 0;
  let verifyFails = false;
  let endFails = false;
  const adapter: MarketplaceAdapter & { createCalls: () => number; failVerify: () => void; failEnd: () => void } = {
    getAuthorizationUrl: (state) => `https://example.test/oauth?state=${state}`,
    exchangeAuthorizationCode: async (code) => ({ accessToken: `access-${code}`, refreshToken: `refresh-${code}`, expiresAt: future(), scopes: ["listings"], externalAccountId: "acct" }),
    refreshAccessToken: async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: future(), scopes: ["listings", "profile"] }),
    verifyConnection: async () => { if (verifyFails) throw new Error("verify failed token-access-code authcode-secret"); return { externalAccountId: "acct" }; },
    createListing: async (_token, payload) => { createCalls += 1; return { externalListingId: `${payload.channel}-${createCalls}`, externalListingUrl: `https://listing.test/${payload.channel}/${createCalls}`, externalStatus: "active", raw: { title: payload.title } }; },
    updateListing: async (_token, id, _payload) => ({ externalListingId: id, externalStatus: "active" }),
    endListing: async (_token, id) => { if (endFails) throw new Error("end failed"); return { externalListingId: id, externalStatus: "ended" }; },
    normalizeError: (error) => { const message = error instanceof Error ? error.message : "temporary"; if (message.includes("auth")) return { type: "Authentication", message: "auth failed", retryable: false }; if (message.includes("permanent")) return { type: "Permanent", message: "permanent failed", retryable: false }; if (message.includes("validation")) return { type: "Validation", message: "validation failed", retryable: false }; return { type: "Temporary", message: "temporary failed", retryable: true }; },
    createCalls: () => createCalls,
    failVerify: () => { verifyFails = true; },
    failEnd: () => { endFails = true; },
    ...overrides,
  };
  return adapter;
}
async function connect(database: TestDb, channel = PublishChannel.Ebay, adapter = makeAdapter(), expiresAt?: string) {
  const state = signedState(channel);
  await completeConnect(database, channel, "code", state, "", "Default", adapter);
  if (expiresAt) await database.update(schema.marketplaceConnections).set({ tokenExpiresAt: expiresAt }).where(eq(schema.marketplaceConnections.channel, channel));
  return adapter;
}
// Sprint 87: every publish workflow requires an eligible explicit Primary ProductPhoto (Ready or
// Processing) to pass validatePublish. Seeded here by default so every pre-existing test in this
// file - which was never about photo eligibility - keeps exercising the same behavior it always
// has, without needing a per-test edit. Pass `{ photo: false }` to get a product with no eligible
// photo for the new Sprint 87 rejection tests.
async function seedEligiblePhoto(database: TestDb, productId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await database.insert(schema.productPhotos).values({
    id: `ph-${productId}`,
    productId,
    url: `/images/product-photos/${productId}.webp`,
    thumbnailUrl: `/images/product-photos/${productId}-thumb.webp`,
    altText: null,
    sortOrder: 0,
    isPrimary: true,
    filename: `${productId}.webp`,
    mimeType: "image/webp",
    sizeBytes: 1024,
    width: 800,
    height: 600,
    processingStatus: "Ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any);
}
async function product(database: TestDb, id = "p1", overrides: { photo?: false | Record<string, unknown> } = {}) {
  await database.insert(schema.products).values({ id, sku: id, title: "Moon", slug: id, type: "single", status: "approved", stockQuantity: 2, priceEur: 10, ebayTitle: "eBay Moon", ebayDescription: "Desc", ebayCategory: "cat", ebayListingPriceEur: 12, etsyTitle: "Etsy Moon", etsyDescription: "Desc", etsyTags: JSON.stringify(["tag"]), etsyListingPriceEur: 13, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  if (overrides.photo !== false) await seedEligiblePhoto(database, id, overrides.photo ?? {});
}

beforeEach(() => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = key; process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret"; process.env.MARKETPLACE_PUBLISH_MAX_RETRIES = "3"; vi.restoreAllMocks(); });

describe("marketplace credential and API security", () => {
  it("encrypts/decrypts, uses different IVs, rejects wrong or missing keys", () => {
    const a = encryptCredential("token"); const b = encryptCredential("token");
    expect(a).not.toBe(b); expect(decryptCredential(a)).toBe("token");
    process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64"); expect(() => decryptCredential(a)).toThrow();
    delete process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY; expect(() => encryptCredential("token")).toThrow(/required/);
  });
  it("never returns raw tokens and stores encrypted access and refresh tokens", async () => {
    const database = db(); await connect(database);
    const [raw] = await database.select().from(schema.marketplaceConnections);
    expect(raw.encryptedAccessToken).not.toContain("access-code"); expect(raw.encryptedRefreshToken).not.toContain("refresh-code");
    const [metadata] = await listConnections(database);
    expect(JSON.stringify(metadata)).not.toContain("access-code"); expect(JSON.stringify(metadata)).not.toContain("refresh-code");
  });
  it("sanitizes tokens/auth codes from errors and logs no token material", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sanitized = sanitizeMarketplaceError(new Error("bad access-token-abc123 refresh-token-def456 authorization-code-xyz"));
    expect(sanitized).not.toContain("abc123"); expect(sanitized).not.toContain("def456"); expect(sanitized).not.toContain("xyz");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("marketplace OAuth and connection safety", () => {
  it("generates signed random expiring state and rejects mismatch/expiry", async () => {
    const a = await startConnect(PublishChannel.Ebay, "Default", makeAdapter()); const b = await startConnect(PublishChannel.Ebay, "Default", makeAdapter());
    expect(a.state).not.toBe(b.state); expect(a.state.split(".")).toHaveLength(2);
    await expect(completeConnect(db(), PublishChannel.Ebay, "code", "bad", "", "Default", makeAdapter())).rejects.toThrow(/state mismatch/i);
    await expect(completeConnect(db(), PublishChannel.Ebay, "code", createOAuthState(PublishChannel.Ebay, "Default", -1), "", "Default", makeAdapter())).rejects.toThrow(/expired/i);
  });
  it("refreshes, verifies success/failure, disconnects, blocks expired publish, rejects unsupported and NoctellaWeb", async () => {
    const database = db(); const adapter = await connect(database); await product(database);
    const refreshed = await refreshConnection(database, PublishChannel.Ebay, adapter); expect(refreshed.scopes).toContain("profile");
    expect((await verifyConnection(database, PublishChannel.Ebay, adapter)).ok).toBe(true);
    adapter.failVerify(); const failed = await verifyConnection(database, PublishChannel.Ebay, adapter); expect(failed.ok).toBe(false); expect(failed.error).not.toContain("token-access-code");
    await connect(database, PublishChannel.Etsy, makeAdapter(), past()); await expect(executePublish(database, "p1", PublishChannel.Etsy, "expired", makeAdapter())).rejects.toThrow(/expired/);
    await disconnect(database, PublishChannel.Ebay); await expect(executePublish(database, "p1", PublishChannel.Ebay, "disc", adapter)).rejects.toThrow(/not connected/);
    await expect(startConnect("amazon" as PublishChannel, "Default", adapter)).rejects.toThrow(/Unsupported/);
    await expect(startConnect(PublishChannel.NoctellaWeb, "Default", adapter)).rejects.toThrow(/Unsupported/);
  });
});

describe("marketplace publish workflow", () => {
  it("publishes eBay and Etsy with backend payloads and persisted audit/listings", async () => {
    const database = db(); const adapter = await connect(database); await connect(database, PublishChannel.Etsy, adapter); await product(database);
    const ebay = await executePublish(database, "p1", PublishChannel.Ebay, "ebay-key", adapter); const etsy = await executePublish(database, "p1", PublishChannel.Etsy, "etsy-key", adapter);
    expect(ebay.job.status).toBe(PublishJobStatus.Succeeded); expect(etsy.job.status).toBe(PublishJobStatus.Succeeded); expect(ebay.job.payloadSnapshot.title).toBe("eBay Moon"); expect(etsy.job.payloadSnapshot.title).toBe("Etsy Moon");
    expect((await getPublishJob(database, ebay.job.id)).attempts).toHaveLength(1); expect(await listExternalListings(database, "p1")).toHaveLength(2);
  });
  it("blocks validation, missing/expired connection before adapter calls", async () => {
    const database = db(); const adapter = makeAdapter(); await database.insert(schema.products).values({ id: "bad", sku: "bad", title: "Bad", slug: "bad", type: "single", status: "approved", stockQuantity: 1, priceEur: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await expect(executePublish(database, "bad", PublishChannel.Ebay, "bad", adapter)).rejects.toThrow(/validation/); expect(adapter.createCalls()).toBe(0);
    await product(database, "p2"); await expect(executePublish(database, "p2", PublishChannel.Ebay, "missing", adapter)).rejects.toThrow(/not connected/); expect(adapter.createCalls()).toBe(0);
  });
  it("deduplicates idempotency, preserves product fields, and filters/paginates jobs", async () => {
    const database = db(); const adapter = await connect(database); await product(database); await database.insert(schema.orders).values({ id: "o1", orderNumber: "N1", guestEmail: "guest@example.com", status: "pending", paymentStatus: "unpaid", subtotalAmount: 10, shippingAmount: 0, taxAmount: 0, totalAmount: 10, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const beforeOrders = await database.select().from(schema.orders); const before = await database.select().from(schema.products).where(eq(schema.products.id, "p1"));
    const first = await executePublish(database, "p1", PublishChannel.Ebay, "same", adapter); const second = await executePublish(database, "p1", PublishChannel.Ebay, "same", adapter);
    const after = await database.select().from(schema.products).where(eq(schema.products.id, "p1"));
    expect(second.job.id).toBe(first.job.id); expect(adapter.createCalls()).toBe(1); expect(await listExternalListings(database, "p1")).toHaveLength(1);
    expect(after[0].stockQuantity).toBe(before[0].stockQuantity); expect(after[0].status).toBe(before[0].status); expect(after[0].priceEur).toBe(before[0].priceEur); expect(await database.select().from(schema.orders)).toEqual(beforeOrders);
    expect(await listPublishJobs(database, { channel: PublishChannel.Ebay, status: PublishJobStatus.Succeeded, limit: 1, offset: 0 })).toHaveLength(1);
  });
  it("handles transient retry success, permanent/auth/validation failures, max retries, and preserves audit history", async () => {
    const database = db(); await connect(database); await product(database);
    let fail = true; const transient = makeAdapter({ createListing: async () => { if (fail) { fail = false; throw new Error("temporary"); } return { externalListingId: "retry-ok", externalStatus: "active" }; } });
    const failed = await executePublish(database, "p1", PublishChannel.Ebay, "retry-key", transient); expect(failed.job.status).toBe(PublishJobStatus.RetryPending);
    const retried = await retryPublishJob(database, failed.job.id, transient); expect(retried.job.status).toBe(PublishJobStatus.Succeeded); expect((await getPublishJob(database, failed.job.id)).attempts).toHaveLength(2);
    // Each remaining failure scenario is an independent, first-time publish attempt, so it uses its
    // own product - p1/Ebay already has an active listing from the retry above (Sprint 62B guard).
    await product(database, "p-permanent"); const permanent = makeAdapter({ createListing: async () => { throw new Error("permanent"); } }); const p = await executePublish(database, "p-permanent", PublishChannel.Ebay, "perm", permanent); expect(p.job.status).toBe(PublishJobStatus.Failed); await expect(retryPublishJob(database, p.job.id, permanent)).rejects.toThrow(/not retryable/);
    await product(database, "p-auth"); const auth = makeAdapter({ createListing: async () => { throw new Error("auth"); } }); expect((await executePublish(database, "p-auth", PublishChannel.Ebay, "auth", auth)).job.status).toBe(PublishJobStatus.Failed);
    await product(database, "p-limit"); process.env.MARKETPLACE_PUBLISH_MAX_RETRIES = "1"; const retryLimit = await executePublish(database, "p-limit", PublishChannel.Ebay, "limit", makeAdapter({ createListing: async () => { throw new Error("temporary"); } })); await expect(retryPublishJob(database, retryLimit.job.id, makeAdapter())).rejects.toThrow(/not retryable/);
  });
  it("ends listings safely and propagates end failures", async () => {
    const database = db(); const adapter = await connect(database); await product(database); await executePublish(database, "p1", PublishChannel.Ebay, "end", adapter);
    const [listing] = await listExternalListings(database, "p1"); await expect(endExternalListing(database, "p1", listing.id, adapter)).resolves.toMatchObject({ status: "ended" });
    adapter.failEnd(); await expect(endExternalListing(database, "p1", listing.id, adapter)).rejects.toThrow(/end failed/);
  });
});

describe("marketplace publish duplicate-listing guard (Sprint 62B)", () => {
  // Same-payload idempotent replay (item 1) is already covered by "deduplicates idempotency..." above -
  // it returns before the new guard runs, so it is unaffected by this feature.
  it("blocks a genuinely new publish while an active listing exists, without touching the adapter or writing a new job/attempt/listing", async () => {
    const database = db(); const adapter = await connect(database); await product(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first", adapter);
    const jobsBefore = await database.select().from(schema.publishJobs);
    const attemptsBefore = await database.select().from(schema.publishAttempts);
    const listingsBefore = await listExternalListings(database, "p1");
    await expect(executePublish(database, "p1", PublishChannel.Ebay, "second", adapter)).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.createCalls()).toBe(1);
    expect(await database.select().from(schema.publishJobs)).toEqual(jobsBefore);
    expect(await database.select().from(schema.publishAttempts)).toEqual(attemptsBefore);
    expect(await listExternalListings(database, "p1")).toEqual(listingsBefore);
  });

  it("a changed publish payload (no explicit key, so a fresh idempotency key is derived) does not bypass the guard", async () => {
    const database = db(); const adapter = await connect(database); await product(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first", adapter);
    await database.update(schema.products).set({ ebayListingPriceEur: 999 }).where(eq(schema.products.id, "p1"));
    await expect(executePublish(database, "p1", PublishChannel.Ebay, undefined, adapter)).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.createCalls()).toBe(1);
  });

  it("allows publishing again once the prior listing is confirmed terminal", async () => {
    const database = db(); const adapter = await connect(database); await product(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first", adapter);
    const [existingListing] = await listExternalListings(database, "p1");
    await database.update(schema.externalListings).set({ externalStatus: "ended" }).where(eq(schema.externalListings.id, existingListing.id));
    const republished = await executePublish(database, "p1", PublishChannel.Ebay, "second", adapter);
    expect(republished.job.status).toBe(PublishJobStatus.Succeeded);
    expect(adapter.createCalls()).toBe(2);
    expect(await listExternalListings(database, "p1")).toHaveLength(2);
  });

  it("a listing on a different channel does not block publishing", async () => {
    const database = db(); const adapter = await connect(database); await connect(database, PublishChannel.Etsy, adapter); await product(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "ebay-first", adapter);
    const etsy = await executePublish(database, "p1", PublishChannel.Etsy, "etsy-first", adapter);
    expect(etsy.job.status).toBe(PublishJobStatus.Succeeded);
  });

  it("a listing for a different product does not block publishing", async () => {
    const database = db(); const adapter = await connect(database); await product(database, "p1"); await product(database, "p2");
    await executePublish(database, "p1", PublishChannel.Ebay, "p1-first", adapter);
    const other = await executePublish(database, "p2", PublishChannel.Ebay, "p2-first", adapter);
    expect(other.job.status).toBe(PublishJobStatus.Succeeded);
  });

  it("treats an unknown/ambiguous external status as blocking, not safely terminal", async () => {
    const database = db(); let calls = 0; const adapter = makeAdapter({ createListing: async (_t, payload) => { calls += 1; return { externalListingId: "weird-1", externalStatus: "under_review", raw: { title: payload.title } }; }, createCalls: () => calls }); await connect(database, PublishChannel.Ebay, adapter); await product(database);
    await executePublish(database, "p1", PublishChannel.Ebay, "first", adapter);
    await expect(executePublish(database, "p1", PublishChannel.Ebay, "second", adapter)).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.createCalls()).toBe(1);
  });
});

describe("marketplace publish direct channel (Noctella Web, Sprint 84)", () => {
  async function noctellaProduct(database: TestDb, id = "nw1", overrides: Partial<{ stockQuantity: number; photo: false | Record<string, unknown> }> = {}) {
    await database.insert(schema.products).values({ id, sku: id, title: "Moon", slug: id, type: "single", status: "draft", stockQuantity: overrides.stockQuantity ?? 1, priceEur: 10, wooProductName: "Web Moon", wooShortDescription: "Short", wooLongDescription: "Long description", wooListingPriceEur: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    if (overrides.photo !== false) await seedEligiblePhoto(database, id, overrides.photo ?? {});
  }

  it("succeeds with no MarketplaceConnection and no adapter argument, publishes the product, and creates no ExternalListing", async () => {
    const database = db();
    await noctellaProduct(database, "nw1");
    const result = await executePublish(database, "nw1", PublishChannel.NoctellaWeb, "nw-key");
    expect(result.job.status).toBe(PublishJobStatus.Succeeded);
    expect(result.externalListing).toBeUndefined();
    expect(await listExternalListings(database, "nw1")).toHaveLength(0);
    expect(await listConnections(database)).toHaveLength(0);
    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "nw1"));
    expect(productRow.status).toBe("published");
  });

  it("never invokes the marketplace adapter for Noctella Web", async () => {
    const database = db();
    await noctellaProduct(database, "nw-spy");
    const createListing = vi.fn();
    const adapter = makeAdapter({ createListing });
    await executePublish(database, "nw-spy", PublishChannel.NoctellaWeb, "spy-key", adapter);
    expect(createListing).not.toHaveBeenCalled();
  });

  it("creates exactly one Succeeded PublishJob with attemptCount 1 and exactly one PublishAttempt with the approved direct-publication snapshots", async () => {
    const database = db();
    await noctellaProduct(database, "nw2");
    const result = await executePublish(database, "nw2", PublishChannel.NoctellaWeb, "nw2-key");
    const jobs = await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw2"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe(PublishJobStatus.Succeeded);
    expect(jobs[0].attemptCount).toBe(1);
    expect(jobs[0].externalListingId).toBeNull();
    expect(jobs[0].externalListingUrl).toBeNull();
    const { attempts } = await getPublishJob(database, result.job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    const request = attempts[0].requestSnapshot as any;
    expect(request.title).toBe("Web Moon");
    expect(request.channel).toBe(PublishChannel.NoctellaWeb);
    const response = attempts[0].responseSnapshot as any;
    expect(response).toMatchObject({ direct: true, channel: PublishChannel.NoctellaWeb, productStatus: "published" });
    expect(response.publishedAt).toBeTruthy();
    expect(response.publishedAt).toBe(jobs[0].completedAt);
  });

  it("repeat execution with the same idempotency key returns the existing job, with no second job/attempt/listing/status mutation", async () => {
    const database = db();
    await noctellaProduct(database, "nw3");
    const first = await executePublish(database, "nw3", PublishChannel.NoctellaWeb, "nw3-key");
    const [afterFirst] = await database.select().from(schema.products).where(eq(schema.products.id, "nw3"));
    const second = await executePublish(database, "nw3", PublishChannel.NoctellaWeb, "nw3-key");
    expect(second.job.id).toBe(first.job.id);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw3"))).toHaveLength(1);
    expect(await database.select().from(schema.publishAttempts).where(eq(schema.publishAttempts.publishJobId, first.job.id))).toHaveLength(1);
    expect(await listExternalListings(database, "nw3")).toHaveLength(0);
    const [afterSecond] = await database.select().from(schema.products).where(eq(schema.products.id, "nw3"));
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecond.status).toBe("published");
  });

  it("validation failure produces no product-status mutation, no job, no attempt, and no external listing", async () => {
    const database = db();
    await noctellaProduct(database, "nw-invalid", { stockQuantity: 0 });
    await expect(executePublish(database, "nw-invalid", PublishChannel.NoctellaWeb, "bad-key")).rejects.toThrow(/validation/);
    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-invalid"));
    expect(productRow.status).toBe("draft");
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw-invalid"))).toHaveLength(0);
    expect(await listExternalListings(database, "nw-invalid")).toHaveLength(0);
  });

  it("still rejects a genuinely unsupported channel value the same way as before", async () => {
    const database = db();
    await noctellaProduct(database, "nw-bogus");
    await expect(executePublish(database, "nw-bogus", "amazon" as PublishChannel, "bogus-key")).rejects.toThrow(/Unsupported/);
  });

  it("connection lifecycle APIs still reject Noctella Web (unchanged)", async () => {
    const adapter = makeAdapter();
    await expect(startConnect(PublishChannel.NoctellaWeb, "Default", adapter)).rejects.toThrow(/Unsupported/);
    await expect(completeConnect(db(), PublishChannel.NoctellaWeb, "code", signedState(PublishChannel.NoctellaWeb), "", "Default", adapter)).rejects.toThrow(/Unsupported/);
    await expect(disconnect(db(), PublishChannel.NoctellaWeb)).rejects.toThrow(/Unsupported/);
  });

  // Sprint 84 correction: the real Admin UI (apps/admin/src/lib/marketplaces.ts's executePublish)
  // sends only `{ channel }` - no idempotencyKey - so `key` is always undefined in production for
  // this channel. Every test above supplied an explicit key; this test instead matches the real
  // request shape exactly, and explicitly proves the automatic-key hash is stable across the very
  // Draft -> Published transition the first call itself causes.
  it("real Admin UI flow: repeat execution with no explicit idempotency key still returns the existing job, and the Draft->Published transition does not change the automatic payload hash", async () => {
    const database = db();
    await noctellaProduct(database, "nw-auto");
    const [beforeUpdate] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-auto"));

    const first = await executePublish(database, "nw-auto", PublishChannel.NoctellaWeb);
    expect(first.job.status).toBe(PublishJobStatus.Succeeded);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw-auto"))).toHaveLength(1);
    expect((await getPublishJob(database, first.job.id)).attempts).toHaveLength(1);
    expect(await listExternalListings(database, "nw-auto")).toHaveLength(0);
    const [afterFirst] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-auto"));
    expect(afterFirst.status).toBe("published");

    // Explicit structural proof (not just behavioral inference): buildPublishPayload for Noctella
    // Web never reads product.status, so recomputing it against the now-Published row produces
    // byte-identical JSON to the pre-update payload - the automatic idempotency-key hash
    // (productId:channel:sha256(payload)) is therefore stable across the very status change this
    // call itself makes.
    const payloadBefore = buildPublishPayload(beforeUpdate as any, [], PublishChannel.NoctellaWeb);
    const payloadAfter = buildPublishPayload(afterFirst as any, [], PublishChannel.NoctellaWeb);
    expect(JSON.stringify(payloadAfter)).toBe(JSON.stringify(payloadBefore));
    expect((payloadBefore as any).status).toBeUndefined();
    expect((payloadAfter as any).status).toBeUndefined();

    const second = await executePublish(database, "nw-auto", PublishChannel.NoctellaWeb);
    expect(second.job.id).toBe(first.job.id);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw-auto"))).toHaveLength(1);
    expect(await database.select().from(schema.publishAttempts).where(eq(schema.publishAttempts.publishJobId, first.job.id))).toHaveLength(1);
    expect(await listExternalListings(database, "nw-auto")).toHaveLength(0);
    const [afterSecond] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-auto"));
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
  });

  // Sprint 84 correction: uses the same SQLite failure-injection pattern already established in
  // this test suite family (e.g. reverseCompletedSaleSprint52B.test.ts's finance-entry trigger) to
  // force the audit-row transaction to fail after updateProduct has already committed, proving both
  // the rollback of the job/attempt pair and clean recovery on retry.
  it("a failure during the job/attempt audit transaction rolls back both rows (product remains Published - approved partial-boundary behavior); a retry with the same automatic-key flow then recovers exactly one job and one attempt", async () => {
    const database = db();
    await noctellaProduct(database, "nw-recover");
    const sqlite = (database as any).$client;
    sqlite.exec("CREATE TRIGGER fail_publish_attempt BEFORE INSERT ON publish_attempts BEGIN SELECT RAISE(ABORT, 'publish attempt insert failed'); END");
    let caught: any;
    try {
      await executePublish(database, "nw-recover", PublishChannel.NoctellaWeb);
    } catch (e) {
      caught = e;
    } finally {
      sqlite.exec("DROP TRIGGER fail_publish_attempt");
    }
    expect(caught).toBeTruthy();
    // The audit transaction (job + attempt) rolled back together - neither row exists.
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw-recover"))).toHaveLength(0);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(0);
    expect(await listExternalListings(database, "nw-recover")).toHaveLength(0);
    // Approved partial-boundary behavior: updateProduct already committed in its own, earlier,
    // self-contained transaction before the audit-insert failure, so the product is already
    // Published even though no job/attempt exists yet to record it - documented and asserted here
    // as the accepted trade-off (see executeNoctellaWebPublish's write-order comment).
    const [afterFailure] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-recover"));
    expect(afterFailure.status).toBe("published");

    const retried = await executePublish(database, "nw-recover", PublishChannel.NoctellaWeb);
    expect(retried.job.status).toBe(PublishJobStatus.Succeeded);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw-recover"))).toHaveLength(1);
    expect(await database.select().from(schema.publishAttempts).where(eq(schema.publishAttempts.publishJobId, retried.job.id))).toHaveLength(1);
    expect(await listExternalListings(database, "nw-recover")).toHaveLength(0);
    const [afterRetry] = await database.select().from(schema.products).where(eq(schema.products.id, "nw-recover"));
    expect(afterRetry.status).toBe("published");
  });
});

describe("Sprint 87: require an eligible explicit Primary ProductPhoto before publishing", () => {
  async function noctellaProduct(database: TestDb, id: string, overrides: Partial<{ stockQuantity: number; photo: false | Record<string, unknown> }> = {}) {
    await database.insert(schema.products).values({ id, sku: id, title: "Moon", slug: id, type: "single", status: "draft", stockQuantity: overrides.stockQuantity ?? 1, priceEur: 10, wooProductName: "Web Moon", wooShortDescription: "Short", wooLongDescription: "Long description", wooListingPriceEur: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    if (overrides.photo !== false) await seedEligiblePhoto(database, id, overrides.photo ?? {});
  }

  it("Noctella Web: rejects execute with no eligible Primary photo - no PublishJob, no PublishAttempt, product status unchanged", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-none", { photo: false });
    await expect(executePublish(database, "nw87-none", PublishChannel.NoctellaWeb, "nw87-none-key")).rejects.toThrow(/validation/);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw87-none"))).toHaveLength(0);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(0);
    const [productRow] = await database.select().from(schema.products).where(eq(schema.products.id, "nw87-none"));
    expect(productRow.status).toBe("draft");
  });

  it("Noctella Web: rejects when photos exist but none is an eligible explicit Primary (non-primary Ready only)", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-nonprimary", { photo: false });
    await seedEligiblePhoto(database, "nw87-nonprimary", { id: "ph-nw87-nonprimary", isPrimary: false, processingStatus: "Ready" });
    await expect(executePublish(database, "nw87-nonprimary", PublishChannel.NoctellaWeb)).rejects.toThrow(/validation/);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw87-nonprimary"))).toHaveLength(0);
  });

  it("Noctella Web: succeeds with an eligible Primary photo in status Ready", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-ready", { photo: { processingStatus: "Ready" } });
    const result = await executePublish(database, "nw87-ready", PublishChannel.NoctellaWeb, "nw87-ready-key");
    expect(result.job.status).toBe(PublishJobStatus.Succeeded);
  });

  it("Noctella Web: succeeds with an eligible Primary photo in status Processing", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-processing", { photo: { processingStatus: "Processing" } });
    const result = await executePublish(database, "nw87-processing", PublishChannel.NoctellaWeb, "nw87-processing-key");
    expect(result.job.status).toBe(PublishJobStatus.Succeeded);
  });

  it("Noctella Web: a Primary photo that is Failed is rejected the same as having none", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-failed", { photo: { processingStatus: "Failed" } });
    await expect(executePublish(database, "nw87-failed", PublishChannel.NoctellaWeb)).rejects.toThrow(/validation/);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw87-failed"))).toHaveLength(0);
  });

  it("Noctella Web: explicit-key idempotent replay still works unchanged once the fixture has an eligible photo", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-idem-explicit", { photo: { processingStatus: "Ready" } });
    const first = await executePublish(database, "nw87-idem-explicit", PublishChannel.NoctellaWeb, "nw87-idem-key");
    const second = await executePublish(database, "nw87-idem-explicit", PublishChannel.NoctellaWeb, "nw87-idem-key");
    expect(second.job.id).toBe(first.job.id);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw87-idem-explicit"))).toHaveLength(1);
  });

  it("Noctella Web: automatic-key (real Admin UI) idempotent replay still works unchanged once the fixture has an eligible photo", async () => {
    const database = db();
    await noctellaProduct(database, "nw87-idem-auto", { photo: { processingStatus: "Ready" } });
    const first = await executePublish(database, "nw87-idem-auto", PublishChannel.NoctellaWeb);
    const second = await executePublish(database, "nw87-idem-auto", PublishChannel.NoctellaWeb);
    expect(second.job.id).toBe(first.job.id);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "nw87-idem-auto"))).toHaveLength(1);
  });

  it("eBay: publish validation fails before any connection/adapter execution when no eligible Primary photo exists, and creates no PublishJob/PublishAttempt", async () => {
    const database = db();
    const adapter = makeAdapter();
    // Deliberately never connect eBay for this product - if validation did not run first, the
    // failure would surface as "not connected" instead of "validation", which would disprove
    // ordering rather than prove it.
    await product(database, "p87-ebay-none", { photo: false });
    await expect(executePublish(database, "p87-ebay-none", PublishChannel.Ebay, "p87-ebay-none-key", adapter)).rejects.toThrow(/validation/);
    expect(adapter.createCalls()).toBe(0);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "p87-ebay-none"))).toHaveLength(0);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(0);
  });

  it("Etsy: publish validation fails before any connection/adapter execution when no eligible Primary photo exists, and creates no PublishJob/PublishAttempt", async () => {
    const database = db();
    const adapter = makeAdapter();
    await product(database, "p87-etsy-none", { photo: false });
    await expect(executePublish(database, "p87-etsy-none", PublishChannel.Etsy, "p87-etsy-none-key", adapter)).rejects.toThrow(/validation/);
    expect(adapter.createCalls()).toBe(0);
    expect(await database.select().from(schema.publishJobs).where(eq(schema.publishJobs.productId, "p87-etsy-none"))).toHaveLength(0);
    expect(await database.select().from(schema.publishAttempts)).toHaveLength(0);
  });

  it("retryPublishJob does not re-validate live ProductPhoto state - a retry still succeeds using the stored payloadSnapshot even after the Primary photo is deleted", async () => {
    const database = db();
    await connect(database);
    await product(database, "p87-retry", { photo: { processingStatus: "Ready" } });
    let fail = true;
    const transient = makeAdapter({ createListing: async () => { if (fail) { fail = false; throw new Error("temporary"); } return { externalListingId: "retry-ok-87", externalStatus: "active" }; } });
    const failed = await executePublish(database, "p87-retry", PublishChannel.Ebay, "p87-retry-key", transient);
    expect(failed.job.status).toBe(PublishJobStatus.RetryPending);

    // The Primary photo that made the original validated attempt legitimate is now gone entirely.
    await database.delete(schema.productPhotos).where(eq(schema.productPhotos.productId, "p87-retry"));

    const retried = await retryPublishJob(database, failed.job.id, transient);
    expect(retried.job.status).toBe(PublishJobStatus.Succeeded);
  });
});
