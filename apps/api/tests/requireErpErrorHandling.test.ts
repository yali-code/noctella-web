// A failure inside requireErp must return a clean response. Express 4 does not catch async
// middleware errors, so an escaping rejection would terminate the process.
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-require-erp-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-require-erp";

vi.mock("../src/services/erpIntegration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/erpIntegration")>();
  return { ...actual, authenticateErp: vi.fn().mockRejectedValue(new Error("simulated database failure")) };
});

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

describe("requireErp authentication failure", () => {
  it("returns a clean 500 without running the handler, and the app keeps serving", async () => {
    const res = await request(app).get("/api/erp/capabilities").set("X-Noctella-ERP-Key", "whatever-key");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
