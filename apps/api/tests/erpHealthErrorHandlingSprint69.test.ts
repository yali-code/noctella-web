// Sprint 69: GET /api/erp/health previously called health(db) with no try/catch. Express 4.x
// does not auto-forward a rejected async-handler promise to error-handling middleware, so a
// database outage at exactly that moment would leave the request hanging instead of returning a
// clean error. Fixed by wrapping the handler body in try/catch and routing failures through the
// same handleRouteError used by every other route in this file.
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-erp-health-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-erp-health";

vi.mock("../src/services/erpIntegration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/erpIntegration")>();
  return { ...actual, health: vi.fn().mockRejectedValue(new Error("simulated database outage")) };
});

let app: import("express").Express;

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
});

describe("GET /api/erp/health error handling (Sprint 69)", () => {
  it("returns a clean error response instead of hanging when the underlying health check throws (public request)", async () => {
    const res = await request(app).get("/api/erp/health");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });

  it("returns a clean error response for an authenticated (keyed) request too", async () => {
    const res = await request(app).get("/api/erp/health").set("X-Noctella-ERP-Key", "whatever-key");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
