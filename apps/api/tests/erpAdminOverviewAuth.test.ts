// /api/erp/admin/overview sits on erpRouter, which is mounted before the global requireAuth. It
// must enforce an admin session itself, and a failure inside it must never reach the process as an
// unhandled rejection (Express 4 does not catch async handler errors).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AdminRole } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-erp-overview-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-erp-overview";

const failHealth = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/services/erpIntegration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/erpIntegration")>();
  return { ...actual, health: (db: never) => (failHealth.enabled ? Promise.reject(new Error("simulated failure")) : actual.health(db)) };
});

const PATH = "/api/erp/admin/overview";
const PASSWORD = "correct-password-123";
let app: import("express").Express;
let ownerCookie: string;
let editorCookie: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
}

beforeAll(async () => {
  app = (await import("../src/app")).default;
  const { db } = await import("../src/db/client");
  const { createAdminUser } = await import("../src/services/adminAuth");
  await createAdminUser(db, { email: "overview-owner@example.com", password: PASSWORD, role: AdminRole.Owner });
  await createAdminUser(db, { email: "overview-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  ownerCookie = await login("overview-owner@example.com");
  editorCookie = await login("overview-editor@example.com");
});

afterEach(() => { failHealth.enabled = false; });

describe("GET /api/erp/admin/overview", () => {
  it("rejects an anonymous request without exposing data", async () => {
    const res = await request(app).get(PATH);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("does not accept an ERP key in place of an admin session", async () => {
    expect((await request(app).get(PATH).set("X-Noctella-ERP-Key", "whatever-key")).status).toBe(401);
  });

  it("rejects an admin without system.admin", async () => {
    const res = await request(app).get(PATH).set("Cookie", editorCookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns the fields the Admin page reads for an authorized admin", async () => {
    const res = await request(app).get(PATH).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.health.status).toBeDefined();
    expect(res.body.health.database).toBe("Healthy");
    expect(res.body.health.productWriteDirectAccessAuditStatus).toBe("not-run-at-runtime");
    for (const field of ["version", "capabilities", "clients", "checkpoints", "audit", "mappingSummary", "recentCommandExecutions"]) expect(res.body).toHaveProperty(field);
  });

  it("returns a clean 500 when the handler fails, and the app keeps serving", async () => {
    failHealth.enabled = true;
    const res = await request(app).get(PATH).set("Cookie", ownerCookie);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("health() no longer depends on source audits that production builds do not ship", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/services/erpIntegration.ts"), "utf8");
    expect(source).not.toContain("scripts/productWriteRepositoryAudit");
  });
});
