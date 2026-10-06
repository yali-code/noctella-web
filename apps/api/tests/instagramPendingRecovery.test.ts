import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { publishInstagramImage } from "../src/services/instagramPublishing";
import * as preparation from "../src/services/socialContentPreparation";
import { encryptCredential } from "../src/services/credentialEncryption";
import { INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../src/integrations/instagram/types";

let db: ReturnType<typeof createTestDb>;
const factory = preparation.createSocialContentPreparationService;
const input = { approvalId: "approval", idempotencyKey: "pending-recovery-001" };
const env = { DATABASE_DRIVER: "test-memory", PUBLIC_API_ORIGIN: "https://api.example.test",
  INSTAGRAM_API_VERSION: "v24.0", INSTAGRAM_ALLOWED_ACCOUNT_IDS: INSTAGRAM_VAULT_ACCOUNT_ID,
  INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.example.test" };
const mediaUrl = env.PUBLIC_API_ORIGIN + "/images/product-photos/instagram-v1-approved.jpg";
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const row = () => db.select().from(schema.instagramPublishAttempts).get()!;
const run = (transport: InstagramTransport, value = input) => publishInstagramImage(db, value, "actor", transport, env, async () => undefined);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function fake() {
  return vi.fn<InstagramTransport>(async (url) => {
    expect((db as any).$client.inTransaction).toBe(false);
    if (url.includes("/me?")) return response({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
    if (url.endsWith("/media")) {
      expect(row()).toMatchObject({ status: "pending", providerEntryState: "claimed", containerId: null });
      return response({ id: "111" });
    }
    if (url.includes("/111?")) return response({ status_code: "FINISHED" });
    if (url.endsWith("/media_publish")) return response({ id: "222" });
    throw new Error("Unexpected mocked request");
  });
}
function seed(providerEntryState: string | null, status = "pending", containerId: string | null = null) {
  db.insert(schema.instagramPublishAttempts).values({ id: "attempt", connectionId: "connection", ...input,
    caption: "Reviewed", mediaUrl, status, containerId, providerEntryState }).run();
}
beforeEach(() => {
  vi.stubEnv("DATABASE_DRIVER", "test-memory");
  vi.stubEnv("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  db = createTestDb();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live calls"));
  vi.spyOn(preparation, "createSocialContentPreparationService").mockImplementation((client) =>
    factory(client, "test-memory", vi.fn().mockRejectedValue(new Error("No rendering")), vi.fn().mockResolvedValue(true)));
  db.insert(schema.adminUsers).values({ id: "actor", email: "actor@example.test", passwordHash: "test-only", role: "owner" }).run();
  db.insert(schema.marketplaceConnections).values({ id: "connection", channel: "instagram", accountLabel: "vault", status: "connected",
    externalAccountId: INSTAGRAM_VAULT_ACCOUNT_ID, encryptedAccessToken: encryptCredential("test-only") }).run();
  db.insert(schema.products).values({ id: "product", sku: "product", title: "Product", slug: "product", type: "unique_item", status: "draft" }).run();
  db.insert(schema.productPhotos).values({ id: "photo", productId: "product", processingStatus: "Ready", url: "/images/product-photos/source.webp",
    thumbnailUrl: "/thumb.webp", filename: "source.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 50 }).run();
  db.insert(schema.socialContents).values({ id: "content", productId: "product", contentType: "post", caption: "Reviewed", status: "approved", version: 2 }).run();
  db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 }).run();
  db.insert(schema.socialPreparedImages).values({ id: "prepared", contentId: "content", sourcePhotoId: "photo", sourceFingerprint: "a".repeat(64),
    recipeVersion: "instagram-v1", outputPath: "/images/product-photos/instagram-v1-approved.jpg" }).run();
  db.insert(schema.socialContentApprovals).values({ id: "approval", requestId: "approval-request", contentId: "content", preparedImageId: "prepared", contentVersion: 1, approvedByAdminUserId: "actor" }).run();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(db.select().from(schema.backgroundJobs).all()).toEqual([]);
  expect(db.select().from(schema.socialPublishIntents).all()).toEqual([]);
  expect(db.select().from(schema.socialPublishSchedules).all()).toEqual([]);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); (db as any).$client.close();
});

it.each([null, "claimed"])("pending with evidence %s never enters provider, regardless of age", async (evidence) => {
  seed(evidence);
  db.update(schema.instagramPublishAttempts).set({ updatedAt: "2000-01-01T00:00:00Z" }).run();
  const transport = fake();
  expect((await run(transport)).status).toBe("pending");
  expect((await run(transport)).status).toBe("pending");
  expect(transport).not.toHaveBeenCalled(); expect(row().providerEntryState).toBe(evidence);
});
it("persists unclaimed evidence before repeatable preflight and recovers after interruption", async () => {
  const interrupted = vi.fn<InstagramTransport>(async (url) => {
    expect(url).toContain("/me?");
    expect(row()).toMatchObject({ status: "pending", providerEntryState: "unclaimed", containerId: null });
    expect((db as any).$client.inTransaction).toBe(false);
    throw new Error("Interrupted read-only preflight");
  });
  await expect(run(interrupted)).rejects.toMatchObject({ kind: "provider" });
  const id = row().id;
  expect(row().providerEntryState).toBe("unclaimed");
  const transport = fake();
  expect(await run(transport)).toMatchObject({ id, status: "published" });
  const count = transport.mock.calls.length;
  expect((await run(transport)).id).toBe(id);
  expect(transport).toHaveBeenCalledTimes(count);
});
it("concurrent recovery grants one owner and fences a delayed preflight", async () => {
  seed("unclaimed");
  const reached = gate(), release = gate(), transport = fake();
  const delayed: InstagramTransport = async (url, init) => {
    if (url.includes("/me?")) { reached.release(); await release.promise; }
    return transport(url, init);
  };
  const oldOwner = run(delayed);
  await reached.promise;
  expect((await run(transport)).status).toBe("published");
  release.release();
  expect((await oldOwner).status).toBe("published");
  expect(transport.mock.calls.filter(([url]) => url.endsWith("/media"))).toHaveLength(1);
  expect(transport.mock.calls.filter(([url]) => url.endsWith("/media_publish"))).toHaveLength(1);
});
it("a late failing preflight cannot overwrite the successful owner's state", async () => {
  seed("unclaimed"); const reached = gate(), release = gate();
  const delayed: InstagramTransport = async () => { reached.release(); await release.promise; throw new Error("Read failed"); };
  const first = run(delayed);
  const rejection = expect(first).rejects.toMatchObject({ kind: "provider" });
  await reached.promise;
  expect((await run(fake())).status).toBe("published");
  release.release(); await rejection;
  expect(row().status).toBe("published");
});
it("failed durable claim prevents container entry", async () => {
  seed("unclaimed");
  (db as any).$client.exec("CREATE TRIGGER reject_claim BEFORE UPDATE OF provider_entry_state ON instagram_publish_attempts BEGIN SELECT RAISE(ABORT, 'claim failed'); END");
  const transport = fake(); await expect(run(transport)).rejects.toThrow();
  expect(row().providerEntryState).toBe("unclaimed");
  expect(transport.mock.calls.some(([url]) => url.endsWith("/media"))).toBe(false);
});
it("a committed claim blocks re-entry while the original container call is unresolved", async () => {
  const reached = gate(), release = gate(), transport = fake();
  const held: InstagramTransport = async (url, init) => {
    if (url.endsWith("/media")) {
      expect(row().providerEntryState).toBe("claimed");
      expect((db as any).$client.inTransaction).toBe(false);
      reached.release(); await release.promise;
    }
    return transport(url, init);
  };
  const first = run(held); await reached.promise;
  const recovery = fake();
  expect((await run(recovery)).status).toBe("pending"); expect(recovery).not.toHaveBeenCalled();
  release.release(); expect((await first).status).toBe("published");
});
it("remote creation followed by failed local container persistence cannot recreate a container", async () => {
  (db as any).$client.exec("CREATE TRIGGER reject_container BEFORE UPDATE OF container_id ON instagram_publish_attempts WHEN NEW.container_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'persistence failed'); END");
  const transport = fake();
  expect((await run(transport)).status).toBe("failed");
  expect(row()).toMatchObject({ providerEntryState: "claimed", containerId: null });
  const count = transport.mock.calls.length;
  await run(transport);
  expect(transport).toHaveBeenCalledTimes(count);
  expect(transport.mock.calls.filter(([url]) => url.endsWith("/media"))).toHaveLength(1);
});
it.each(["container_created", "processing", "ready"])("known %s container resumes without recreation", async (status) => {
  seed("claimed", status, "111"); const transport = fake();
  expect((await run(transport)).status).toBe("published");
  expect(transport.mock.calls.some(([url]) => url.endsWith("/media"))).toBe(false);
});
it.each(["publishing", "published", "failed", "reconciliation_required"])("%s never re-enters provider", async (status) => {
  seed("claimed", status, "111"); const transport = fake();
  expect((await run(transport)).status).toBe(status); expect(transport).not.toHaveBeenCalled();
});
it("preserves approval and request uniqueness", async () => {
  seed("unclaimed");
  await expect(run(fake(), { ...input, approvalId: "other" })).rejects.toThrow(/bound/);
  await expect(run(fake(), { ...input, idempotencyKey: "other-request-001" })).rejects.toThrow(/already/);
  expect(() => db.insert(schema.instagramPublishAttempts).values({ ...row(), id: "other", idempotencyKey: "other-request-001" }).run()).toThrow();
  expect(db.select().from(schema.instagramPublishAttempts).all()).toHaveLength(1);
});
it("revalidates approved content before recovering an unstarted attempt", async () => {
  seed("unclaimed"); db.update(schema.socialContents).set({ version: 3 }).run();
  const transport = fake(); await expect(run(transport)).rejects.toThrow(/changed/);
  expect(transport).not.toHaveBeenCalled(); expect(row().providerEntryState).toBe("unclaimed");
});
it("rechecks authorization before claiming after preflight", async () => {
  const transport: InstagramTransport = async () => {
    db.update(schema.adminUsers).set({ role: "product_editor" }).run();
    return response({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
  };
  await expect(run(transport)).rejects.toMatchObject({ kind: "authorization" });
  expect(row().providerEntryState).toBe("unclaimed");
});
it("fresh and upgraded SQLite preserve historical uncertainty without defaults or backfill", async () => {
  seed(null); const historical = row(); const sqlite = (db as any).$client;
  const column = () => sqlite.prepare("PRAGMA table_info(instagram_publish_attempts)").all().find((c: any) => c.name === "provider_entry_state");
  expect(column()).toMatchObject({ notnull: 0, dflt_value: null });
  sqlite.exec("ALTER TABLE instagram_publish_attempts DROP COLUMN provider_entry_state");
  ensureSchema(sqlite); ensureSchema(sqlite);
  expect(row()).toEqual(historical); expect(column()).toMatchObject({ notnull: 0, dflt_value: null });
  const transport = fake(); expect((await run(transport)).status).toBe("pending"); expect(transport).not.toHaveBeenCalled();
  expect(() => db.update(schema.instagramPublishAttempts).set({ providerEntryState: "unsafe" }).where(eq(schema.instagramPublishAttempts.id, historical.id)).run()).toThrow();
});
