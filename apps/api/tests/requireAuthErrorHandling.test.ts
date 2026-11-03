// A session lookup failure inside requireAuth must fail closed with a clean response. Express 4
// does not catch async middleware errors, so an escaping rejection would terminate the process.
import { describe, expect, it, vi } from "vitest";
import { createRequireAuth } from "../src/auth/permissions";
import { SESSION_COOKIE_NAME } from "../src/auth/cookies";

function response() {
  const res: any = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}

describe("requireAuth session lookup failure", () => {
  it("returns 500 without authenticating, and does not reject", async () => {
    const db: any = { select: () => { throw new Error("simulated database failure"); } };
    const req: any = { headers: { cookie: `${SESSION_COOKIE_NAME}=some-token` } };
    const res = response();
    const next = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createRequireAuth(db)(req, res, next)).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(next).not.toHaveBeenCalled();
    expect(req.adminUser).toBeUndefined();
    consoleError.mockRestore();
  });

  it("still returns 401 when no session cookie is sent", async () => {
    const res = response();
    const next = vi.fn();
    await createRequireAuth({} as any)({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
