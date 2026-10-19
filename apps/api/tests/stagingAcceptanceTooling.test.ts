/**
 * F2 closure Stage 1: the staging acceptance tooling against the REAL API (production router, real auth/CSRF,
 * disposable file SQLite and storage, mock AI provider; on Linux CI with MANDATORY confined preparation through the
 * packaged launcher). Proves the driver's route/envelope/status assumptions, its exit codes, the lost-ack proxy's
 * exactly-once result, and (Linux) the deterministic park-at-intent sequence: live executor refused, killed executor
 * recovered by the API itself. Genuinely cross-instance BLOCKED behaviour needs another instance and stays a staging step.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { AdminRole } from "@noctella/shared";

const { root, launcher } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-staging-tooling-"));
  const launcher = process.platform === "linux" ? process.env.F2_CAPABILITY_LAUNCHER : undefined;
  Object.assign(process.env, {
    DATABASE_URL: join(root, "api.sqlite"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"), AI_INTAKE_PROVIDER: "mock",
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "staging-tooling",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
    ...(launcher ? { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: launcher } : {}),
  });
  delete process.env.DATABASE_DRIVER;
  return { root, launcher };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const driverModule = path.join(__dirname, "..", "..", "..", "scripts", "photo-staging-acceptance", "staging-driver.mjs");
let server: import("node:http").Server, db: any, env: Record<string, string>, categoryId: string, adminId: string;
const events: Array<Record<string, any>> = [];
const run = async (argv: string[], extra: Record<string, string | undefined> = {}) => {
  const { runDriver } = await import(driverModule);
  return runDriver(argv, { ...env, ...extra }, (event: string, data: object) => events.push({ event, ...data })) as Promise<number>;
};
const last = (event: string) => [...events].reverse().find((e) => e.event === event)!;
const count = (table: string, where = "") => Number(db.all(sql.raw(`SELECT COUNT(*) AS n FROM ${table} ${where}`))[0].n);
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required: the tooling runs against the confined (mandatory) protected path", () => {
  expect(launcher).toBeTruthy();
  expect(process.env.PHOTO_PREPARATION_CONFINEMENT).toBe("required");
});

beforeAll(async () => {
  const app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  const { createAdminUser } = await import("../src/services/adminAuth");
  adminId = (await createAdminUser(db, { email: "f2-staging@offline.test", role: AdminRole.Owner, password: "offline-password-123" }) as any).id;
  categoryId = (await (await import("../src/services/categories")).createCategory(db, { name: "F2 staging", displayOrder: 0, isActive: true })).id;
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  env = { F2_STAGING_API: `http://127.0.0.1:${port}`, F2_STAGING_CONFIRM_HOST: `127.0.0.1:${port}`, F2_STAGING_TARGET_SERVICE_ID: "srv-localtooling01",
    F2_PRODUCTION_HOSTS: "api.production.invalid", F2_STAGING_EMAIL: "f2-staging@offline.test", F2_STAGING_PASSWORD: "offline-password-123" };
  const img = (name: string, w: number, h: number, color: string, quality = 80) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg({ quality }).toFile(path.join(root, name));
  await img("a.jpg", 320, 240, "#804020"); await img("b.jpg", 320, 240, "#204080"); await img("c.jpg", 300, 200, "#408020"); await img("small.jpg", 200, 150, "#806040", 70);
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await (await import("../src/db/client")).dbRuntime.shutdown();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("staging driver against the real API", () => {
  let productId = "";

  it("refuses an unconfirmed or production target before logging in (no session is created)", async () => {
    const sessions = count("admin_sessions");
    await expect(run(["w2", "x", path.join(root, "a.jpg")], { F2_STAGING_TARGET_SERVICE_ID: undefined })).rejects.toThrow(/TARGET_SERVICE_ID/);
    await expect(run(["w2", "x", path.join(root, "a.jpg")], { F2_PRODUCTION_HOSTS: env.F2_STAGING_CONFIRM_HOST })).rejects.toThrow(/production host/);
    expect(count("admin_sessions")).toBe(sessions);
  });

  it("w4: create -> stage -> mock generate -> accept title -> stock acceptance -> finalize (201) -> repeat (200)", async () => {
    expect(await run(["w4", categoryId, path.join(root, "a.jpg"), path.join(root, "b.jpg")])).toBe(0);
    const w4 = last("w4");
    expect(w4).toMatchObject({ finalize: 201, photos: 2, repeat: 200, repeatPhotos: 2, pass: true });
    productId = w4.productId;
    expect(count("photo_operations", "WHERE kind = 'ai_finalize' AND state = 'committed'")).toBe(2);
  });

  it("w2 and w2-replay: real multipart/Idempotency-Key contract; replay returns the same photo", async () => {
    expect(await run(["w2", productId, path.join(root, "c.jpg")])).toBe(0);
    expect(last("w2")).toMatchObject({ status: 201, pass: true });
    expect(await run(["w2-replay", productId, path.join(root, "a.jpg")])).toBe(0);
    expect(last("w2-replay")).toMatchObject({ first: 201, second: 201, samePhoto: true, pass: true });
  });

  it("w2-lost-ack: the response is dropped only after the durable commit; the retry is exactly-once", async () => {
    const photos = path.join(root, "photos");
    const before = { files: files(photos), photos: count("product_photos"), outbox: count("outbox_events") };
    expect(await run(["w2-lost-ack", productId, path.join(root, "b.jpg")])).toBe(0);
    const r = last("w2-lost-ack");
    expect(r).toMatchObject({ upstreamStatus: 201, retryStatus: 201, sameIdAsCommitted: true, pass: true });
    expect(r.clientOutcome).toMatch(/^ack-lost/);
    expect(count("photo_operations", `WHERE subject_id = '${r.key}' AND state = 'committed'`)).toBe(1);
    expect([files(photos), count("product_photos"), count("outbox_events")]).toEqual([before.files + 2, before.photos + 1, before.outbox + 1]);
  });

  it("failed acceptance exits nonzero; a refused protected request is reported by w2-expect", async () => {
    expect(await run(["w2", "no-such-product", path.join(root, "a.jpg")])).toBe(1);
    const saved = { mode: process.env.PHOTO_PREPARATION_CONFINEMENT, launcher: process.env.PHOTO_PREPARATION_LAUNCHER };
    Object.assign(process.env, { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: path.join(root, "missing-launcher") });
    try {
      const before = files(path.join(root, "photos"));
      expect(await run(["w2-expect", productId, path.join(root, "c.jpg"), "f2-refused-0000000000001", "503", "PHOTO_PUBLICATION_NOT_READY"])).toBe(0);
      expect(await run(["w2-expect", productId, path.join(root, "c.jpg"), "f2-refused-0000000000002", "201", "x"])).toBe(1);
      expect(files(path.join(root, "photos"))).toBe(before);
    } finally {
      for (const [k, v] of [["PHOTO_PREPARATION_CONFINEMENT", saved.mode], ["PHOTO_PREPARATION_LAUNCHER", saved.launcher]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it.runIf(!!launcher)("park-at-intent (Linux, confined): live executor refused, attestation of it refused, killed executor recovered once", async () => {
    const parkEnv = { ...process.env, F2_STAGING_ACCEPTANCE: "enabled", RENDER_SERVICE_ID: "srv-localtooling01", F2_STAGING_TARGET_SERVICE_ID: "srv-localtooling01" };
    const child: ChildProcess = spawn(process.execPath, [path.join(__dirname, "..", "..", "..", "scripts", "photo-staging-acceptance", "park-at-intent.mjs"), productId, path.join(root, "small.jpg"), adminId],
      { cwd: path.resolve(__dirname, ".."), env: parkEnv, stdio: ["ignore", "pipe", "inherit"] });
    let parked: any;
    try {
      parked = await new Promise((resolve, reject) => {
        let buf = "";
        child.stdout!.on("data", (d) => { buf += d; for (const line of buf.split("\n")) { try { const m = JSON.parse(line); if (m.event === "PARKED") resolve(m); if (m.event === "REFUSED") reject(new Error(m.message)); } catch { /* partial */ } } });
        child.once("exit", () => reject(new Error("orchestrator exited: " + buf)));
      });
      expect(await run(["w2-expect", productId, path.join(root, "small.jpg"), parked.idempotencyKey, "409", "PHOTO_OPERATION_IN_PROGRESS"])).toBe(0);
      const { reportPublicationIntents, attestExecutorExit } = await import("../src/scripts/photoPublicationIntentRecovery");
      const intent = (await reportPublicationIntents(db, "sqlite")).find((r: any) => r.subjectId === parked.idempotencyKey)!;
      expect(intent).toMatchObject({ state: "authorized", epoch: "1", resumable: false });
      expect(await attestExecutorExit(db, "sqlite", { operationId: intent.operationId, epoch: 1, executorIdentity: intent.executorIdentity, operator: "ops", evidence: "test: executor still running" }))
        .toMatchObject({ recorded: false, reason: expect.stringMatching(/^refused: .*alive/) });
      process.kill(parked.childPid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      expect(await run(["w2", productId, path.join(root, "small.jpg"), parked.idempotencyKey])).toBe(0);
      const [row] = db.all(sql`SELECT i.state, i.executor_epoch FROM photo_publication_intents i JOIN photo_operations o ON o.id = i.operation_id WHERE o.subject_id = ${parked.idempotencyKey}`) as any[];
      expect([row.state, Number(row.executor_epoch)]).toEqual(["committed", 2]);
    } finally { child.kill("SIGINT"); }
  });
});
