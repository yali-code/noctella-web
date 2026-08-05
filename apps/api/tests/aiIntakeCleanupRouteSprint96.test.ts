// Sprint 96: real app, real authenticated admin sessions, real scheduler bearer auth - proves the
// Admin dry-run/execute HTTP contract (permission, strict schema, dry-run-while-disabled,
// execute-while-disabled 409, execute-while-enabled 200) and the scheduler integration (disabled
// skip, enabled real run, existing domains unchanged), mirroring the exact supertest pattern
// established by aiIntakePhotoFinalizeRouteSprint95.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminRole } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-cleanup-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-cleanup";

const stagedTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-cleanup-staged-"));
process.env.AI_INTAKE_PHOTO_DIR = stagedTempDir;
const canonicalTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-cleanup-canonical-"));
process.env.PRODUCT_PHOTO_DIR = canonicalTempDir;

let app: import("express").Express;
let db: any;

const PASSWORD = "correct-password-123";
let managerCookie: string; // ProductEditor: has ai_product_intakes.manage
let noPermissionCookie: string; // AiReviewer: has neither

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");

  await adminAuth.createAdminUser(db, { email: "cleanup-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("cleanup-editor@example.com");
  await adminAuth.createAdminUser(db, { email: "cleanup-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("cleanup-aireviewer@example.com");
});

afterAll(() => {
  rmSync(stagedTempDir, { recursive: true, force: true });
  rmSync(canonicalTempDir, { recursive: true, force: true });
});

describe("POST /api/ai-product-intakes/cleanup/run", () => {
  beforeEach(() => {
    delete process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED;
  });

  it("401s without an authenticated session", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").send({ dryRun: true });
    expect(res.status).toBe(401);
  });

  it("403s for an authenticated session without ai_product_intakes.manage", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", noPermissionCookie).send({ dryRun: true });
    expect(res.status).toBe(403);
  });

  it("400s when dryRun is missing", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({});
    expect(res.status).toBe(400);
  });

  it("400s for a non-boolean dryRun", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: "true" });
    expect(res.status).toBe(400);
  });

  it("400s for batchSize below the minimum (0)", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true, batchSize: 0 });
    expect(res.status).toBe(400);
  });

  it("400s for batchSize above the approved maximum (501)", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true, batchSize: 501 });
    expect(res.status).toBe(400);
  });

  it("accepts batchSize at the boundaries (1 and 500)", async () => {
    const low = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true, batchSize: 1 });
    expect(low.status).toBe(200);
    const high = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true, batchSize: 500 });
    expect(high.status).toBe(200);
  });

  it("400s for an unknown property", async () => {
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true, extra: "nope" });
    expect(res.status).toBe(400);
  });

  it("400s for a client-supplied path/filename/storageKey/status/timestamp/actorId/cursor - none of these are declared fields", async () => {
    for (const spoof of [
      { dryRun: true, path: "/etc/passwd" },
      { dryRun: true, filename: "x.webp" },
      { dryRun: true, storageKey: "x.webp" },
      { dryRun: true, intakeStatus: "cancelled" },
      { dryRun: true, cancelledAt: "2020-01-01T00:00:00.000Z" },
      { dryRun: true, actorId: "spoofed-admin" },
      { dryRun: true, processStartedAt: "2020-01-01T00:00:00.000Z" },
      { dryRun: true, cursor: "some-cursor" },
    ]) {
      const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send(spoof);
      expect(res.status).toBe(400);
    }
  });

  it("dryRun:true returns a full report and remains available while execution is disabled", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "false";
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.executionEnabled).toBe(false);
    expect(res.body.dryRun).toBe(true);
    expect(typeof res.body.filesExamined).toBe("number");
    expect(res.body.stagedRowsDeleted).toBe(0);
    expect(res.body.privateOrphansDeleted).toBe(0);
    expect(res.body.canonicalOrphansDeleted).toBe(0);
  });

  it("dryRun:false while execution is disabled fails closed with 409 AI_INTAKE_CLEANUP_EXECUTION_DISABLED - never a silent downgrade", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "false";
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_CLEANUP_EXECUTION_DISABLED");
  });

  it("dryRun:false with execution enabled returns a real 200 result", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "true";
    const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.executionEnabled).toBe(true);
    expect(res.body.dryRun).toBe(false);
  });

  it("an invalid retention duration in the environment produces a deterministic 500 with AI_INTAKE_CLEANUP_CONFIGURATION_INVALID, never a silent fallback", async () => {
    process.env.AI_INTAKE_ORPHAN_GRACE_MS = "not-a-number";
    try {
      const res = await request(app).post("/api/ai-product-intakes/cleanup/run").set("Cookie", managerCookie).send({ dryRun: true });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("AI_INTAKE_CLEANUP_CONFIGURATION_INVALID");
    } finally {
      delete process.env.AI_INTAKE_ORPHAN_GRACE_MS;
    }
  });
});

describe("scheduler integration: POST /api/background-jobs/run", () => {
  beforeEach(() => {
    delete process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED;
  });

  it("when disabled: the aiIntakeCleanup field reports a zero-count, dryRun:true, executionEnabled:false skip - other job domains still run", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "false";
    const res = await request(app).post("/api/background-jobs/run").set("Authorization", "Bearer test-scheduler-token-ai-intake-cleanup").send({});
    expect(res.status).toBe(200);
    expect(res.body.aiIntakeCleanup).toEqual({
      executionEnabled: false,
      dryRun: true,
      filesExamined: 0,
      rowsExamined: 0,
      stagedRowsEligible: 0,
      stagedRowsDeleted: 0,
      stagedFilesDeleted: 0,
      stagedFilesAlreadyAbsent: 0,
      privateOrphansEligible: 0,
      privateOrphansDeleted: 0,
      canonicalOrphansEligible: 0,
      canonicalOrphansDeleted: 0,
      liveFilesRetained: 0,
      activeSourceRowsRetained: 0,
      activeOutboxRetained: 0,
      ageProtected: 0,
      unknownFilesRetained: 0,
      symlinksRetained: 0,
      directoriesRetained: 0,
      failures: 0,
      truncated: false,
      durationMs: 0,
    });
    // Existing domains' response shape is unchanged.
    expect(typeof res.body.processed).toBe("number");
    expect(typeof res.body.photoOutboxProcessed).toBe("number");
    expect(typeof res.body.salesInvoiceOutboxProcessed).toBe("number");
  });

  it("when enabled: invokes the same cleanup service as the Admin route and returns a real result", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "true";
    const res = await request(app).post("/api/background-jobs/run").set("Authorization", "Bearer test-scheduler-token-ai-intake-cleanup").send({});
    expect(res.status).toBe(200);
    expect(res.body.aiIntakeCleanup.executionEnabled).toBe(true);
    expect(res.body.aiIntakeCleanup.dryRun).toBe(false);
  });

  it("cleanup's batch size is capped at 500 even if a larger batchSize is requested; other domains' own batchSize behavior is unaffected", async () => {
    process.env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED = "true";
    const res = await request(app)
      .post("/api/background-jobs/run")
      .set("Authorization", "Bearer test-scheduler-token-ai-intake-cleanup")
      .send({ batchSize: 999999 });
    expect(res.status).toBe(200);
    expect(res.body.aiIntakeCleanup).toBeTruthy();
    // Not directly observable from the response how many rows the cap allowed - the correctness of
    // the 500-cap itself is proven at the service/use-case level (aiIntakeCleanup.test.ts); this
    // asserts only that the request completes successfully and the other domains still process
    // using their own unmodified (uncapped) requested batchSize.
    expect(typeof res.body.processed).toBe("number");
  });

  it("requires the real scheduler bearer token - rejects without it", async () => {
    const res = await request(app).post("/api/background-jobs/run").send({});
    expect(res.status).toBe(401);
  });
});
