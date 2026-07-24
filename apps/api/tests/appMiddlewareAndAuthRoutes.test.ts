// Exercises the real, fully-wired Express app (src/app.ts) end-to-end via supertest, including
// the actual middleware/route mount order from src/app.ts - this is the only reliable way to
// prove the route-protection matrix (public/machine/authenticated-admin) is wired correctly,
// as opposed to unit-testing each middleware function in isolation.
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

// db/client.ts creates its singleton connection at import time, reading DATABASE_URL - it must
// be set before src/app.ts (which transitively imports db/client.ts) is ever imported. Vitest
// isolates each test file's module registry, so this is safe here without affecting other files.
process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token";

let app: import("express").Express;
let db: any;
let schema: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];

const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = "correct-password-123";

async function loginAndGetCookie(): Promise<string> {
  const res = await request(app).post("/api/auth/login").set("Origin", "http://localhost:3001").send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  schema = await import("../src/db/schema");
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;
  await createAdminUser(db, { email: OWNER_EMAIL, password: OWNER_PASSWORD, role: "owner" });
});

describe("public routes remain reachable without any session (Sprint 64B)", () => {
  it("GET /health requires no auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("public storefront product listing requires no auth", async () => {
    const res = await request(app).get("/api/public/products");
    expect(res.status).not.toBe(401);
  });

  it("marketplace webhook route is independent of admin auth (fails on signature, not on missing session)", async () => {
    // Actual mounted path: routes/marketplaceSync.ts mounts /webhooks/:channel under the
    // router that index.ts/app.ts itself mounts at /api/webhooks (pre-existing, unrelated to
    // this sprint - not something to "fix" here).
    const res = await request(app).post("/api/webhooks/webhooks/ebay").send({});
    expect(res.status).not.toBe(401);
    if (res.body?.error) expect(res.body.error).not.toBe("Authentication required");
  });
});

describe("machine-authenticated routes are independent of admin sessions (Sprint 64B)", () => {
  it("ERP routes remain gated by requireErp, not by an admin session", async () => {
    const res = await request(app).get("/api/erp/capabilities");
    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe("Authentication required");
  });

  it("the scheduler job-run route rejects requests with no bearer token", async () => {
    const res = await request(app).post("/api/background-jobs/run").send({});
    expect(res.status).toBe(401);
  });

  it("the scheduler job-run route rejects an incorrect bearer token", async () => {
    const res = await request(app).post("/api/background-jobs/run").set("Authorization", "Bearer wrong-token").send({});
    expect(res.status).toBe(401);
  });

  it("the scheduler job-run route accepts the correct bearer token without any admin session", async () => {
    const res = await request(app).post("/api/background-jobs/run").set("Authorization", "Bearer test-scheduler-token").send({});
    expect(res.status).toBe(200);
  });
});

describe("login route (Sprint 64B)", () => {
  it("rejects invalid credentials with 401", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: OWNER_EMAIL, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("succeeds with correct credentials and sets a secure-attributed cookie", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: OWNER_EMAIL, role: "owner", status: "active" });
    expect(res.body.passwordHash).toBeUndefined();
    const setCookie = String(res.headers["set-cookie"]?.[0] ?? res.headers["set-cookie"]);
    expect(setCookie).toContain("noctella_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure"); // NODE_ENV is not "production" in tests
  });
});

describe("business routes require a valid admin session by default (Sprint 64B)", () => {
  it("a protected route returns 401 with no session cookie", async () => {
    const res = await request(app).get("/api/categories");
    expect(res.status).toBe(401);
  });

  it("a spoofed x-admin-role header has no effect on an unauthenticated request", async () => {
    const res = await request(app).get("/api/categories").set("x-admin-role", "owner").set("x-user-role", "owner");
    expect(res.status).toBe(401);
  });

  it("succeeds once a real session cookie is presented", async () => {
    const cookie = await loginAndGetCookie();
    const res = await request(app).get("/api/categories").set("Cookie", cookie);
    expect(res.status).not.toBe(401);
  });

  it("GET /api/auth/me requires auth and returns only safe identity fields", async () => {
    const unauth = await request(app).get("/api/auth/me");
    expect(unauth.status).toBe(401);

    const cookie = await loginAndGetCookie();
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: OWNER_EMAIL, role: "owner", status: "active" });
    expect(Object.keys(res.body).sort()).toEqual(["email", "id", "role", "status"]);
  });

  it("logout clears the session so it can no longer authenticate", async () => {
    const cookie = await loginAndGetCookie();
    const out = await request(app).post("/api/auth/logout").set("Origin", "http://localhost:3001").set("Cookie", cookie);
    expect(out.status).toBe(200);
    const setCookie = String(out.headers["set-cookie"]?.[0] ?? out.headers["set-cookie"]);
    expect(setCookie).toContain("noctella_admin_session=;");

    const after = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });

  it("logout is safe when no session exists at all", async () => {
    const res = await request(app).post("/api/auth/logout").set("Origin", "http://localhost:3001");
    expect(res.status).toBe(200);
  });
});

describe("CORS allowlist (Sprint 64B)", () => {
  it("echoes an allowed admin origin with credentials enabled", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:3001");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not echo a disallowed origin", async () => {
    const res = await request(app).get("/health").set("Origin", "http://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CSRF / Origin validation for authenticated mutations (Sprint 64B)", () => {
  it("rejects a mutation whose Origin header does not match the configured admin origin, even with a valid session", async () => {
    const cookie = await loginAndGetCookie();
    const res = await request(app).post("/api/categories").set("Cookie", cookie).set("Origin", "http://evil.example.com").send({ name: "Test", isActive: true, displayOrder: 0 });
    expect(res.status).toBe(403);
  });

  it("allows a mutation from the configured admin origin with a valid session to reach business logic", async () => {
    const cookie = await loginAndGetCookie();
    const res = await request(app).post("/api/categories").set("Cookie", cookie).set("Origin", "http://localhost:3001").send({ name: "Test Category", isActive: true, displayOrder: 0 });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does not reject a mutation with no Origin header at all (non-browser callers)", async () => {
    const cookie = await loginAndGetCookie();
    const res = await request(app).post("/api/categories").set("Cookie", cookie).send({ name: "No Origin Header", isActive: true, displayOrder: 0 });
    expect(res.status).not.toBe(403);
  });

  it("does not apply the Admin-origin requirement to GET requests", async () => {
    const cookie = await loginAndGetCookie();
    const res = await request(app).get("/api/categories").set("Cookie", cookie).set("Origin", "http://evil.example.com");
    expect(res.status).not.toBe(403);
  });
});

describe("regression: unrelated admin user rows are never affected by other tests (Sprint 64B)", () => {
  it("still exactly one admin user exists", async () => {
    const users = await db.select().from(schema.adminUsers);
    expect(users.filter((u: any) => u.email === OWNER_EMAIL)).toHaveLength(1);
  });
});
