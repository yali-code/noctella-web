import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketplaceConnections } from "../src/db/schema";
import { getWooCommerceConnection, normalizeWooCommerceStoreUrl, saveWooCommerceConnection, verifyWooCommerceConnection, WooCommerceClient, WooCommerceClientError } from "../src/integrations/woocommerce/connectionClient";
import { createTestDb } from "./testDb";

describe("WooCommerce connection/client boundary", () => {
  beforeEach(() => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); });
  it("normalizes safe URLs and rejects malformed or credential-bearing URLs", () => {
    expect(normalizeWooCommerceStoreUrl("https://shop.example.test/")).toBe("https://shop.example.test");
    expect(() => normalizeWooCommerceStoreUrl("ftp://shop.example.test")).toThrow(WooCommerceClientError);
    expect(() => normalizeWooCommerceStoreUrl("https://user:pass@shop.example.test")).toThrow(WooCommerceClientError);
  });
  it("encrypts credentials and never returns them", async () => {
    const db = createTestDb();
    const safe = await saveWooCommerceConnection(db, { storeUrl: "https://shop.example.test/", consumerKey: "ck_test", consumerSecret: "cs_test" });
    expect(safe).not.toHaveProperty("consumerSecret"); expect(safe.status).toBe("configured");
    const [raw] = await db.select().from(marketplaceConnections);
    expect(raw.encryptedAccessToken).not.toContain("ck_test"); expect(raw.encryptedRefreshToken).not.toContain("cs_test");
    expect(await getWooCommerceConnection(db)).toEqual(safe);
  });
  it("constructs verification against injected transport and transitions to verified", async () => {
    const db = createTestDb(), request = vi.fn().mockResolvedValue({ status: 200 });
    await saveWooCommerceConnection(db, { storeUrl: "https://shop.example.test", consumerKey: "ck", consumerSecret: "cs" });
    expect((await verifyWooCommerceConnection(db, { request })).status).toBe("verified");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", url: "https://shop.example.test/wp-json/wc/v3/system_status" }));
  });
  it.each([[401,"authentication"],[403,"authorization"],[429,"rate_limit"]])("classifies HTTP %s", async (status, kind) => {
    const client = new WooCommerceClient({ storeUrl: "https://shop.example.test", consumerKey: "ck", consumerSecret: "cs" }, { request: vi.fn().mockResolvedValue({ status }) });
    await expect(client.verify()).rejects.toMatchObject({ kind });
  });
  it("classifies transport rejection as timeout without real HTTP", async () => {
    const client = new WooCommerceClient({ storeUrl: "https://shop.example.test", consumerKey: "ck", consumerSecret: "cs" }, { request: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(client.verify()).rejects.toMatchObject({ kind: "timeout" });
  });
});
