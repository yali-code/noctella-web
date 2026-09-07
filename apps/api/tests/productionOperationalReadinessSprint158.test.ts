import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { adminLoginRateLimit, ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS } from "../src/middleware/adminLoginRateLimit";
import { logUnhandledRequestError, requestObservability } from "../src/middleware/requestObservability";
import { handleRouteError } from "../src/routes/errorHandler";
import { validateProductionApiConfig } from "../src/config/productionConfig";

afterEach(() => vi.restoreAllMocks());

describe("Sprint 158 Admin login HTTP limiter", () => {
  function app() {
    const instance = express();
    instance.use(express.json());
    instance.post("/api/auth/login", adminLoginRateLimit, (_req, res) => res.json({ ok: true }));
    instance.get("/health", (_req, res) => res.json({ status: "ok" }));
    return instance;
  }

  it("allows the documented threshold, then returns a safe 429 without account leakage", async () => {
    const instance = app();
    for (let attempt = 0; attempt < ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      expect((await request(instance).post("/api/auth/login").send({ email: "owner@example.com", password: "secret" })).status).toBe(200);
    }
    const blocked = await request(instance).post("/api/auth/login").send({ email: "unknown@example.com", password: "different" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many login attempts. Please try again later." });
    expect(JSON.stringify(blocked.body)).not.toMatch(/owner|unknown|account|password/i);
  });

  it("does not limit an unrelated public endpoint", async () => expect((await request(app()).get("/health")).status).toBe(200));
});

describe("Sprint 158 request correlation and safe structured logs", () => {
  function app() {
    const instance = express();
    instance.use(requestObservability);
    const auth = express.Router();
    auth.post("/login", (_req, res) => res.json({ ok: true }));
    const orders = express.Router();
    orders.get("/:orderId", (_req, res) => res.json({ ok: true }));
    const customers = express.Router();
    customers.get("/:id", (_req, res) => res.json({ ok: true }));
    const failingOrders = express.Router();
    failingOrders.get("/:orderId", (_req, _res, next) => next(new Error("nested-order-exception-secret")));
    const failingCustomers = express.Router();
    failingCustomers.get("/:id", (_req, _res, next) => next(new Error("nested-customer-exception-secret")));
    const delayed = express.Router();
    delayed.get("/:id", (_req, res) => setTimeout(() => res.json({ ok: true }), 0));
    instance.use("/api/auth", auth);
    instance.use("/api/orders", orders);
    instance.use("/api/customers", customers);
    instance.use("/api/failing-orders", failingOrders);
    instance.use("/api/failing-customers", failingCustomers);
    instance.use("/api/delayed", delayed);
    instance.get("/ok", (_req, res) => res.json({ ok: true }));
    instance.get("/resource/:resourceId", (_req, res) => res.json({ ok: true }));
    instance.get("/fail", (_req, res) => handleRouteError(new Error("password=secret DATABASE_URL=postgres://secret"), res));
    instance.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logUnhandledRequestError(res);
      res.status(500).json({ error: "Internal server error" });
    });
    return instance;
  }

  it("generates a request ID and emits a machine-readable completion log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await request(app()).get("/ok");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const entry = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(entry).toMatchObject({ event: "request_complete", requestId: response.headers["x-request-id"], method: "GET", route: "/ok", status: 200, category: "success" });
    expect(entry.durationMs).toEqual(expect.any(Number));
  });

  it("captures the complete nested static route while trusted router metadata is active", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await request(app()).post("/api/auth/login");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).route).toBe("/api/auth/login");
  });

  it("captures a complete nested parameter template without its concrete ID or query", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sensitive = "order-secret-158";
    await request(app()).get(`/api/orders/${sensitive}?token=query-secret-158`);
    const output = JSON.stringify(log.mock.calls);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).route).toBe("/api/orders/:orderId");
    expect(output).not.toContain(sensitive);
    expect(output).not.toContain("query-secret-158");
  });

  it("keeps identical local parameter routes distinct through their trusted mount prefixes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await request(app()).get("/api/orders/order-1");
    await request(app()).get("/api/customers/customer-1");
    const routes = log.mock.calls.map((call) => JSON.parse(String(call[0])).route);
    expect(routes).toContain("/api/orders/:orderId");
    expect(routes).toContain("/api/customers/:id");
  });

  it("preserves the complete nested route through next(error) and correlates safe error/completion events once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitive = "order-error-secret-158";
    const response = await request(app()).get(`/api/failing-orders/${sensitive}?token=query-error-secret`).set("X-Request-Id", "nested-error-158");
    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toBe("nested-error-158");
    expect(log).toHaveBeenCalledTimes(1);
    const completion = JSON.parse(String(log.mock.calls[0][0]));
    const errorEvent = JSON.parse(String(error.mock.calls[0][0]));
    expect(completion).toMatchObject({ event: "request_complete", requestId: "nested-error-158", route: "/api/failing-orders/:orderId", status: 500 });
    expect(errorEvent).toMatchObject({ event: "request_error", requestId: "nested-error-158", category: "unhandled" });
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output).not.toContain(sensitive);
    expect(output).not.toContain("query-error-secret");
    expect(output).not.toContain("nested-order-exception-secret");
  });

  it("keeps distinct nested error routes distinguishable after router unwind", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await request(app()).get("/api/failing-orders/order-1");
    await request(app()).get("/api/failing-customers/customer-1");
    const routes = log.mock.calls.map((call) => JSON.parse(String(call[0])).route);
    expect(routes).toEqual(["/api/failing-orders/:orderId", "/api/failing-customers/:id"]);
  });

  it("preserves the complete nested template for asynchronously delayed completion", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sensitive = "delayed-secret-158";
    const response = await request(app()).get(`/api/delayed/${sensitive}`);
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0])).route).toBe("/api/delayed/:id");
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  });

  it("logs a stable route template without path parameters or query values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sensitive = "customer-secret-ORDER-158";
    await request(app()).get(`/resource/${sensitive}?token=query-secret`);
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("/resource/:resourceId");
    expect(output).not.toContain(sensitive);
    expect(output).not.toContain("query-secret");
  });

  it("classifies unmatched attacker-controlled paths without logging them", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const attackerPath = "unmatched-secret-158";
    await request(app()).get(`/${attackerPath}`);
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("UNMATCHED");
    expect(output).not.toContain(attackerPath);
  });

  it("propagates a valid inbound ID and rejects an unsafe inbound value", async () => {
    expect((await request(app()).get("/ok").set("X-Request-Id", "deploy-158.test_1")).headers["x-request-id"]).toBe("deploy-158.test_1");
    expect((await request(app()).get("/ok").set("X-Request-Id", "unsafe token with spaces")).headers["x-request-id"]).not.toBe("unsafe token with spaces");
  });

  it("keeps the existing safe 500 body, correlates it, and never logs sensitive exception text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(app()).get("/fail").set("X-Request-Id", "failure-158");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(response.headers["x-request-id"]).toBe("failure-158");
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output).toContain("failure-158");
    expect(output).not.toMatch(/password|secret|DATABASE_URL|postgres:/i);
  });
});

describe("Sprint 158 production configuration validation", () => {
  const valid: NodeJS.ProcessEnv = { NODE_ENV: "production", DATABASE_DRIVER: "sqlite", DATABASE_URL: "/var/data/noctella.sqlite", PRODUCT_PHOTO_DIR: "/var/data/product-photos", ADMIN_APP_ORIGIN: "https://admin.noctella.example", STOREFRONT_APP_ORIGIN: "https://shop.noctella.example", COOKIE_DOMAIN: ".noctella.example", SCHEDULER_AUTH_TOKEN: "scheduler-value", ERP_INTEGRATION_KEY: "erp-value", MOCK_PAYMENTS_ENABLED: "false" };

  it("accepts the controlled production topology", () => expect(() => validateProductionApiConfig(valid)).not.toThrow());
  it("preserves development and test ergonomics", () => expect(() => validateProductionApiConfig({ NODE_ENV: "test" })).not.toThrow());
  it.each([
    ["the persistent mount root", { PRODUCT_PHOTO_DIR: "/var/data" }],
    ["a normalized persistent mount-root alias", { PRODUCT_PHOTO_DIR: "/var/data/." }],
    ["the database path equal to the photo root", { DATABASE_URL: "/var/data/product-photos", PRODUCT_PHOTO_DIR: "/var/data/product-photos" }],
    ["the database immediately inside the photo root", { DATABASE_URL: "/var/data/product-photos/noctella.sqlite" }],
    ["the database nested beneath the photo root", { DATABASE_URL: "/var/data/product-photos/private/noctella.sqlite" }],
    ["a dot-segment database overlap", { DATABASE_URL: "/var/data/product-photos/./private/noctella.sqlite" }],
    ["a parent-segment database overlap", { DATABASE_URL: "/var/data/product-photos/temp/../private/noctella.sqlite" }],
  ])("rejects PRODUCT_PHOTO_DIR when it exposes %s without exposing configured values", (_scenario, override) => {
    const configured = { ...valid, ...override };
    expect(() => validateProductionApiConfig(configured)).toThrow(/PRODUCT_PHOTO_DIR/);
    try { validateProductionApiConfig(configured); } catch (error) {
      const output = String(error);
      expect(output).not.toContain(String(configured.DATABASE_URL));
      expect(output).not.toContain(String(configured.PRODUCT_PHOTO_DIR));
      expect(output).not.toContain("scheduler-value");
      expect(output).not.toContain("erp-value");
    }
  });

  it("accepts a deeper dedicated photo root when the database remains its sibling", () => {
    expect(() => validateProductionApiConfig({ ...valid, PRODUCT_PHOTO_DIR: "/var/data/media/product-photos" })).not.toThrow();
  });

  it("accepts a database path whose sibling directory only shares the photo-root prefix", () => {
    expect(() => validateProductionApiConfig({ ...valid, DATABASE_URL: "/var/data/photos-old/noctella.sqlite", PRODUCT_PHOTO_DIR: "/var/data/photos" })).not.toThrow();
  });

  it.each([
    ["DATABASE_DRIVER", { DATABASE_DRIVER: "postgres" }], ["DATABASE_URL", { DATABASE_URL: ":memory:" }], ["DATABASE_URL", { DATABASE_URL: "relative.sqlite" }], ["DATABASE_URL", { DATABASE_URL: "/tmp/noctella.sqlite" }], ["DATABASE_URL", { DATABASE_URL: "/var/data" }], ["DATABASE_URL", { DATABASE_URL: "/var/data/../outside.sqlite" }], ["PRODUCT_PHOTO_DIR", { PRODUCT_PHOTO_DIR: "uploads/photos" }], ["PRODUCT_PHOTO_DIR", { PRODUCT_PHOTO_DIR: "/tmp/product-photos" }], ["PRODUCT_PHOTO_DIR", { PRODUCT_PHOTO_DIR: "/var/data/../photos" }], ["ADMIN_APP_ORIGIN", { ADMIN_APP_ORIGIN: "http://localhost:3001" }], ["STOREFRONT_APP_ORIGIN", { STOREFRONT_APP_ORIGIN: "not-a-url" }], ["COOKIE_DOMAIN", { COOKIE_DOMAIN: "localhost" }], ["COOKIE_DOMAIN", { COOKIE_DOMAIN: "https://noctella.example" }], ["COOKIE_DOMAIN", { COOKIE_DOMAIN: ".unrelated.example" }], ["COOKIE_DOMAIN", { COOKIE_DOMAIN: ".evilnoctella.example" }], ["SCHEDULER_AUTH_TOKEN", { SCHEDULER_AUTH_TOKEN: "" }], ["ERP_INTEGRATION_KEY", { ERP_INTEGRATION_KEY: "" }], ["MOCK_PAYMENTS_ENABLED", { MOCK_PAYMENTS_ENABLED: "true" }], ["STRIPE_PUBLIC_CHECKOUT_ENABLED", { STRIPE_PUBLIC_CHECKOUT_ENABLED: "true" }],
  ])("fails closed for %s without exposing configured values", (variable, override) => {
    expect(() => validateProductionApiConfig({ ...valid, ...override })).toThrow(new RegExp(String(variable)));
    try { validateProductionApiConfig({ ...valid, ...override }); } catch (error) {
      expect(String(error)).not.toContain("scheduler-value");
      expect(String(error)).not.toContain("erp-value");
    }
  });

  it("accepts exact hosts and boundary-safe subdomains of the cookie domain", () => {
    expect(() => validateProductionApiConfig({ ...valid, ADMIN_APP_ORIGIN: "https://noctella.example", STOREFRONT_APP_ORIGIN: "https://deep.shop.noctella.example", COOKIE_DOMAIN: "noctella.example" })).not.toThrow();
  });
});

describe("Sprint 158 real startup validation boundary", () => {
  it("fails before database initialization with a safe variable-specific diagnostic", () => {
    const databasePath = join(tmpdir(), `noctella-secret-${crypto.randomUUID()}.sqlite`);
    rmSync(databasePath, { force: true });
    const result = spawnSync(process.execPath, ["-r", "tsx/cjs", "src/index.ts"], {
      cwd: join(process.cwd()),
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_DRIVER: "sqlite",
        DATABASE_URL: databasePath,
        PRODUCT_PHOTO_DIR: "/var/data/product-photos",
        ADMIN_APP_ORIGIN: "https://admin.noctella.example",
        STOREFRONT_APP_ORIGIN: "https://shop.noctella.example",
        COOKIE_DOMAIN: ".noctella.example",
        SCHEDULER_AUTH_TOKEN: "startup-scheduler-secret-158",
        ERP_INTEGRATION_KEY: "startup-erp-secret-158",
        MOCK_PAYMENTS_ENABLED: "false",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain(databasePath);
    expect(output).not.toContain("startup-scheduler-secret-158");
    expect(output).not.toContain("startup-erp-secret-158");
    expect(existsSync(databasePath)).toBe(false);
  });
});
