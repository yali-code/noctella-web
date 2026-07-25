// Sprint 69: the generic 500 fallback in routes/errorHandler.ts previously logged an unmapped
// exception's raw, unredacted message to console.error - a real risk if that message ever
// embeds a secret (an ERP key, scheduler token, connection string, etc. from an upstream
// failure). A redaction-based fix was tried first (reusing sanitizeMarketplaceError), but any
// pattern-based redactor can still miss a secret shape it wasn't written for. Fixed instead by
// never touching `err` at all for the log line - only a fixed operational message is logged.
import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { handleRouteError } from "../src/routes/errorHandler";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../src/services/errors";
import { InsufficientInventoryError, InvalidInventoryQuantityError, ProductNotFoundApplicationError } from "../src/application/inventory/errors";

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

const SECRETS = [
  "pw=abc123",
  "postgres://user:hunter2@db.internal:5432/noctella",
  "Authorization: Bearer test-secret-value-abc123",
];

describe("handleRouteError safe logging (Sprint 69)", () => {
  it.each(SECRETS)("never logs a secret embedded in the error message (%s)", (secret) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();

    handleRouteError(new Error(`Upstream request failed: ${secret}`), res);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = errorSpy.mock.calls[0];
    expect(JSON.stringify(loggedArgs)).not.toContain(secret);
    errorSpy.mockRestore();
  });

  it("logs only the fixed operational message - never err, err.message, or a JSON.stringify of it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    const err = new Error("pw=abc123");

    handleRouteError(err, res);

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("Unhandled route error");
    errorSpy.mockRestore();
  });

  it("still returns the generic 500 response body - the secret is never exposed to the client either", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    handleRouteError(new Error("failed with token abcdefghijklmnop"), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    vi.restoreAllMocks();
  });

  it("logs the same fixed message (not silently swallowed) for a non-Error unknown throw", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    handleRouteError("a plain string throw", res);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("Unhandled route error");
    expect(res.statusCode).toBe(500);
    errorSpy.mockRestore();
  });

  it("preserves every existing typed error mapping unchanged", () => {
    const cases: [unknown, number][] = [
      [new UnauthorizedError(), 401],
      [new NotFoundError(), 404],
      [new ConflictError("conflict"), 409],
      [new BadRequestError("bad request"), 400],
      [new ProductNotFoundApplicationError(), 404],
      [new InsufficientInventoryError(), 409],
      [new InvalidInventoryQuantityError(), 400],
    ];
    for (const [err, status] of cases) {
      const res = mockRes();
      handleRouteError(err, res);
      expect(res.statusCode).toBe(status);
    }

    const zodRes = mockRes();
    try {
      z.object({ x: z.string() }).parse({});
    } catch (zodErr) {
      expect(zodErr).toBeInstanceOf(ZodError);
      handleRouteError(zodErr, zodRes);
      expect(zodRes.statusCode).toBe(400);
      expect(zodRes.body.error).toBe("Validation failed");
    }
  });
});
