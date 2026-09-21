import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { marketplaceConnections, instagramPublishAttempts } from "../src/db/schema";
import { InstagramClient } from "../src/integrations/instagram/InstagramClient";
import { InstagramClientError, INSTAGRAM_SCOPES, INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "../src/integrations/instagram/types";
import { getInstagramConnection, upsertInstagramConnection } from "../src/integrations/instagram/connection";
import { validateInstagramMediaUrl } from "../src/config/instagramConfig";
import { publishInstagramImage } from "../src/services/instagramPublishing";
import { createInstagramRouter } from "../src/routes/instagram";
import { createAdminUser, login } from "../src/services/adminAuth";

const token = "test-only-secret-token";
const env = { INSTAGRAM_API_VERSION: "v24.0", INSTAGRAM_ALLOWED_ACCOUNT_IDS: INSTAGRAM_VAULT_ACCOUNT_ID, INSTAGRAM_MEDIA_ALLOWED_HOSTS: "cdn.example.test", MARKETPLACE_REQUEST_TIMEOUT_MS: "100" } as NodeJS.ProcessEnv;
const imageUrl = "https://cdn.example.test/photo.jpg";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeTransport(options: { accountId?: string; status?: string; publishFailure?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: InstagramTransport = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/me?")) return response({ id: options.accountId ?? INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
    if (url.includes("/media_publish")) {
      if (options.publishFailure) throw Object.assign(new Error("secret-bearing provider content"), { name: "AbortError" });
      return response({ id: "222" });
    }
    if (url.includes("/media")) return response({ id: "111" });
    if (url.includes("/111?")) return response({ status_code: options.status ?? "FINISHED" });
    throw new Error("Unexpected fake request");
  });
  return { calls, transport };
}

const originalKey = process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY;
beforeEach(() => { process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64"); });
afterEach(() => {
  if (originalKey === undefined) delete process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

describe("Instagram Vault-only client and media policy", () => {
  it("uses Bearer authorization without token in URL and rejects a different account ID", async () => {
    const good = fakeTransport();
    expect(await new InstagramClient(token, good.transport, env).verifyAccount()).toEqual({ id: INSTAGRAM_VAULT_ACCOUNT_ID, username: "noctella.vault" });
    expect(good.calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(good.calls[0].url).not.toContain(token);
    const wrong = fakeTransport({ accountId: "17841400000000000" });
    await expect(new InstagramClient(token, wrong.transport, env).verifyAccount()).rejects.toMatchObject({ kind: "authorization" });
  });

  it.each([[401, "authentication"], [403, "authorization"], [429, "rate_limit"]] as const)("normalizes HTTP %i to %s without provider body leakage", async (status, kind) => {
    const transport: InstagramTransport = async () => response({ error: { message: token } }, status);
    await expect(new InstagramClient(token, transport, env).verifyAccount()).rejects.toMatchObject({ kind });
  });

  it("normalizes timeout and malformed bodies", async () => {
    const timedOut: InstagramTransport = async () => { throw Object.assign(new Error(token), { name: "AbortError" }); };
    await expect(new InstagramClient(token, timedOut, env).verifyAccount()).rejects.toMatchObject({ kind: "timeout" });
    const malformed: InstagramTransport = async () => response({ unexpected: token });
    await expect(new InstagramClient(token, malformed, env).verifyAccount()).rejects.toBeInstanceOf(InstagramClientError);
  });

  it("accepts only explicitly allowed public HTTPS DNS hosts", () => {
    expect(validateInstagramMediaUrl(imageUrl, env)).toBe(imageUrl);
    for (const candidate of ["http://cdn.example.test/photo.jpg", "https://other.example.test/photo.jpg", "https://localhost/photo.jpg", "https://127.0.0.1/photo.jpg", "https://user:pass@cdn.example.test/photo.jpg", "file:///photo.jpg", "data:image/png,abc"]) {
      expect(() => validateInstagramMediaUrl(candidate, env)).toThrowError(InstagramClientError);
    }
    expect(() => validateInstagramMediaUrl(imageUrl, { ...env, INSTAGRAM_MEDIA_ALLOWED_HOSTS: "" })).toThrowError(InstagramClientError);
    expect(() => validateInstagramMediaUrl(`${imageUrl}${"x".repeat(4096)}`, env)).toThrowError(InstagramClientError);
    const exact = { ...env, INSTAGRAM_MEDIA_ALLOWED_HOSTS: "cdn.noctella.example" };
    expect(validateInstagramMediaUrl("https://cdn.noctella.example/path/image.jpg", exact)).toBe("https://cdn.noctella.example/path/image.jpg");
    expect(() => validateInstagramMediaUrl("https://evilcdn.noctella.example/path/image.jpg", exact)).toThrowError(InstagramClientError);
    expect(() => validateInstagramMediaUrl("https://cdn.noctella.example.evil.com/image.jpg", exact)).toThrowError(InstagramClientError);
  });
});

describe("Instagram connection and publish ownership", () => {
  it("verifies Vault before encrypted persistence and never returns credential fields", async () => {
    const db = createTestDb();
    const fake = fakeTransport();
    const saved = await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fake.transport, env);
    expect(saved.externalAccountId).toBe(INSTAGRAM_VAULT_ACCOUNT_ID);
    expect(JSON.stringify(saved)).not.toContain(token);
    const [stored] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, "instagram"));
    expect(stored.encryptedAccessToken).toMatch(/^v1:/);
    expect(stored.encryptedAccessToken).not.toContain(token);
    expect(stored.encryptedRefreshToken).toBeNull();
    expect((await getInstagramConnection(db))?.scopes).toEqual([...INSTAGRAM_SCOPES]);
  });

  it("rejects another account, extra scopes, or a widened account allowlist without persistence", async () => {
    const db = createTestDb();
    await expect(upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fakeTransport({ accountId: "999" }).transport, env)).rejects.toMatchObject({ kind: "authorization" });
    await expect(upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES, "instagram_business_manage_messages"] }, fakeTransport().transport, env)).rejects.toMatchObject({ kind: "configuration" });
    await expect(upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fakeTransport().transport, { ...env, INSTAGRAM_ALLOWED_ACCOUNT_IDS: `${INSTAGRAM_VAULT_ACCOUNT_ID},999` })).rejects.toMatchObject({ kind: "configuration" });
    expect(await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, "instagram"))).toHaveLength(0);
  });

  it("fails closed for a pre-existing non-Vault connection and oversized token", async () => {
    const db = createTestDb();
    const fake = fakeTransport();
    await expect(upsertInstagramConnection(db, { accessToken: "x".repeat(8193), scopes: [...INSTAGRAM_SCOPES] }, fake.transport, env)).rejects.toMatchObject({ kind: "configuration" });
    expect(fake.calls).toHaveLength(0);
    await db.insert(marketplaceConnections).values({ id: "conn_wrong", channel: "instagram", accountLabel: "vault", externalAccountId: "999", status: "connected" }).run();
    await expect(getInstagramConnection(db)).rejects.toMatchObject({ kind: "authorization" });
    await expect(publishInstagramImage(db, { imageUrl, caption: "No", idempotencyKey: "ig-wrong-vault-001" }, fake.transport, env)).rejects.toMatchObject({ kind: "configuration" });
    expect(fake.calls).toHaveLength(0);
  });

  it("creates one container, checks readiness, publishes once and persists a safe result", async () => {
    const db = createTestDb();
    const fake = fakeTransport();
    await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fake.transport, env);
    const input = { imageUrl, caption: "Vault image", idempotencyKey: "ig-test-publish-001" };
    const result = await publishInstagramImage(db, input, fake.transport, env);
    expect(result.status).toBe("published");
    expect(result.containerId).toBe("111");
    expect(result.publishedMediaId).toBe("222");
    expect(fake.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    const again = await publishInstagramImage(db, input, fake.transport, env);
    expect(again).toEqual(result);
    expect(fake.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    const [stored] = await db.select().from(instagramPublishAttempts);
    expect(stored.status).toBe("published");
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("bounds processing without publishing and never repeats an uncertain publish", async () => {
    const db = createTestDb();
    const setup = fakeTransport();
    await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, setup.transport, env);
    const processing = fakeTransport({ status: "IN_PROGRESS" });
    const input = { imageUrl, caption: "Pending image", idempotencyKey: "ig-test-processing-001" };
    const pending = await publishInstagramImage(db, input, processing.transport, env, async () => undefined);
    expect(pending.status).toBe("processing");
    expect(processing.calls.filter((call) => call.url.includes("/111?"))).toHaveLength(5);
    expect(processing.calls.some((call) => call.url.includes("/media_publish"))).toBe(false);
    const resumed = fakeTransport();
    const completed = await publishInstagramImage(db, input, resumed.transport, env, async () => undefined);
    expect(completed.status).toBe("published");
    expect(completed.id).toBe(pending.id);
    expect(resumed.calls.some((call) => call.url.endsWith("/media"))).toBe(false);
    expect(resumed.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    const uncertain = fakeTransport({ publishFailure: true });
    const other = { imageUrl, caption: "Uncertain image", idempotencyKey: "ig-test-uncertain-001" };
    const first = await publishInstagramImage(db, other, uncertain.transport, env);
    expect(first.status).toBe("reconciliation_required");
    expect(first.lastError).toBe("timeout");
    await publishInstagramImage(db, other, uncertain.transport, env);
    expect(uncertain.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
  });

  it("resumes known container and ready states, but never retries publishing, reconciliation or published", async () => {
    const db = createTestDb();
    const fake = fakeTransport();
    await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fake.transport, env);
    const input = { imageUrl, caption: "Recovery", idempotencyKey: "ig-recovery-001" };
    const processing = await publishInstagramImage(db, input, fakeTransport({ status: "IN_PROGRESS" }).transport, env, async () => undefined);
    await db.update(instagramPublishAttempts).set({ status: "container_created" }).where(eq(instagramPublishAttempts.id, processing.id)).run();
    const resumed = fakeTransport();
    expect((await publishInstagramImage(db, input, resumed.transport, env)).status).toBe("published");
    expect(resumed.calls.some((call) => call.url.endsWith("/media"))).toBe(false);
    expect(resumed.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    expect((await publishInstagramImage(db, input, resumed.transport, env)).status).toBe("published");
    expect(resumed.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    await db.update(instagramPublishAttempts).set({ status: "ready" }).where(eq(instagramPublishAttempts.id, processing.id)).run();
    expect((await publishInstagramImage(db, input, resumed.transport, env)).status).toBe("published");
    expect(resumed.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(2);
    for (const status of ["publishing", "reconciliation_required"] as const) {
      await db.update(instagramPublishAttempts).set({ status }).where(eq(instagramPublishAttempts.id, processing.id)).run();
      expect((await publishInstagramImage(db, input, resumed.transport, env)).status).toBe(status);
      expect(resumed.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(2);
    }
  });

  it("permits only one container creation for simultaneous initial requests", async () => {
    const db = createTestDb();
    await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fakeTransport().transport, env);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeTransport();
    const transport: InstagramTransport = async (url, init) => {
      if (url.endsWith("/media")) { entered(); await held; }
      return fake.transport(url, init);
    };
    const input = { imageUrl, caption: "Concurrent", idempotencyKey: "ig-concurrent-001" };
    const first = publishInstagramImage(db, input, transport, env);
    await reached;
    const second = await publishInstagramImage(db, input, transport, env);
    expect(second.status).toBe("pending");
    release();
    expect((await first).status).toBe("published");
    expect(fake.calls.filter((call) => call.url.endsWith("/media"))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
  });

  it("permits only one publish for simultaneous processing resumptions", async () => {
    const db = createTestDb();
    await upsertInstagramConnection(db, { accessToken: token, scopes: [...INSTAGRAM_SCOPES] }, fakeTransport().transport, env);
    const input = { imageUrl, caption: "Concurrent resume", idempotencyKey: "ig-concurrent-resume-001" };
    await publishInstagramImage(db, input, fakeTransport({ status: "IN_PROGRESS" }).transport, env, async () => undefined);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeTransport();
    const transport: InstagramTransport = async (url, init) => {
      if (url.includes("/111?")) { entered(); await held; }
      return fake.transport(url, init);
    };
    const first = publishInstagramImage(db, input, transport, env);
    await reached;
    const second = publishInstagramImage(db, input, transport, env);
    release();
    await Promise.all([first, second]);
    expect(fake.calls.filter((call) => call.url.includes("/media_publish"))).toHaveLength(1);
    expect(fake.calls.some((call) => call.url.endsWith("/media"))).toBe(false);
  });

  it("requires Admin authentication and returns only sanitized connection/publish state", async () => {
    const db = createTestDb();
    const fake = fakeTransport();
    const app = express(); app.use(express.json()); app.use("/api/instagram", createInstagramRouter(db, fake.transport, env));
    expect((await request(app).get("/api/instagram/connection")).status).toBe(401);
    expect((await request(app).post("/api/instagram/connection").send({ accessToken: token, scopes: [...INSTAGRAM_SCOPES] })).status).toBe(401);
    await createAdminUser(db, { email: "owner@example.test", password: "safe-test-password-123", role: "owner" });
    const session = await login(db, { email: "owner@example.test", password: "safe-test-password-123" });
    const cookie = `noctella_admin_session=${session.rawToken}`;
    const saved = await request(app).post("/api/instagram/connection").set("Cookie", cookie).send({ accessToken: token, scopes: [...INSTAGRAM_SCOPES] });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(token);
    const read = await request(app).get("/api/instagram/connection").set("Cookie", cookie);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(token);
    const published = await request(app).post("/api/instagram/publish").set("Cookie", cookie).send({ imageUrl, caption: "Safe caption", idempotencyKey: "ig-route-test-001" });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("published");
    expect(JSON.stringify(published.body)).not.toContain(token);
    const badId = await request(app).get(`/api/instagram/attempts/${"x".repeat(100)}`).set("Cookie", cookie);
    expect(badId.status).toBe(400);
    const tooLongToken = await request(app).post("/api/instagram/connection").set("Cookie", cookie).send({ accessToken: "x".repeat(8193), scopes: [...INSTAGRAM_SCOPES] });
    expect(tooLongToken.status).toBe(400);
    expect(JSON.stringify(tooLongToken.body)).not.toContain("x".repeat(128));
  });
});
