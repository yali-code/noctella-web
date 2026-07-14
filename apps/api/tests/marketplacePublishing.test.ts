import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { MarketplaceConnectionStatus, PublishChannel, PublishJobStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { decryptCredential, encryptCredential } from "../src/services/credentialEncryption";
import { createOAuthState } from "../src/services/oauthState";
import { completeConnect, disconnect, endExternalListing, executePublish, getPublishJob, listConnections, listExternalListings, listPublishJobs, refreshConnection, retryPublishJob, sanitizeMarketplaceError, startConnect, verifyConnection } from "../src/services/marketplacePublishing";
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
async function product(database: TestDb, id = "p1") {
  await database.insert(schema.products).values({ id, sku: id, title: "Moon", slug: id, type: "single", status: "approved", stockQuantity: 2, priceEur: 10, ebayTitle: "eBay Moon", ebayDescription: "Desc", ebayCategory: "cat", ebayListingPriceEur: 12, etsyTitle: "Etsy Moon", etsyDescription: "Desc", etsyTags: JSON.stringify(["tag"]), etsyListingPriceEur: 13, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
    const permanent = makeAdapter({ createListing: async () => { throw new Error("permanent"); } }); const p = await executePublish(database, "p1", PublishChannel.Ebay, "perm", permanent); expect(p.job.status).toBe(PublishJobStatus.Failed); await expect(retryPublishJob(database, p.job.id, permanent)).rejects.toThrow(/not retryable/);
    const auth = makeAdapter({ createListing: async () => { throw new Error("auth"); } }); expect((await executePublish(database, "p1", PublishChannel.Ebay, "auth", auth)).job.status).toBe(PublishJobStatus.Failed);
    process.env.MARKETPLACE_PUBLISH_MAX_RETRIES = "1"; const retryLimit = await executePublish(database, "p1", PublishChannel.Ebay, "limit", makeAdapter({ createListing: async () => { throw new Error("temporary"); } })); await expect(retryPublishJob(database, retryLimit.job.id, makeAdapter())).rejects.toThrow(/not retryable/);
  });
  it("ends listings safely and propagates end failures", async () => {
    const database = db(); const adapter = await connect(database); await product(database); await executePublish(database, "p1", PublishChannel.Ebay, "end", adapter);
    const [listing] = await listExternalListings(database, "p1"); await expect(endExternalListing(database, "p1", listing.id, adapter)).resolves.toMatchObject({ status: "ended" });
    adapter.failEnd(); await expect(endExternalListing(database, "p1", listing.id, adapter)).rejects.toThrow(/end failed/);
  });
});
