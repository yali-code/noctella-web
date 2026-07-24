import { Router } from "express";
import { db } from "../db/client";
import { createRequireAuth } from "../auth/permissions";
import { requireAdminOriginForMutations } from "../auth/csrf";
import { parseCookieHeader, serializeClearCookie, serializeSessionCookie, SESSION_COOKIE_NAME } from "../auth/cookies";
import { login, logout } from "../services/adminAuth";
import { handleRouteError } from "./errorHandler";

const router = Router();
const requireAuth = createRequireAuth(db);

/** Public. Generic failure response for every failure mode (see services/adminAuth.ts's login). */
router.post("/login", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const result = await login(db, {
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
    res.setHeader("Set-Cookie", serializeSessionCookie(result.rawToken, result.expiresAt));
    res.status(200).json({ id: result.user.id, email: result.user.email, role: result.user.role, status: result.user.status });
  } catch (e) {
    handleRouteError(e, res);
  }
});

/** Safe/idempotent even when no valid session exists. Requires a matching Admin origin like any other mutation. */
router.post("/logout", requireAdminOriginForMutations, async (req, res) => {
  try {
    const cookies = parseCookieHeader(req.headers.cookie);
    await logout(db, cookies[SESSION_COOKIE_NAME]);
    res.setHeader("Set-Cookie", serializeClearCookie());
    res.status(200).json({ ok: true });
  } catch (e) {
    handleRouteError(e, res);
  }
});

/** Requires authentication. Returns only safe identity fields - never password/session internals. */
router.get("/me", requireAuth, (req, res) => {
  const user = (req as any).adminUser;
  res.status(200).json({ id: user.id, email: user.email, role: user.role, status: user.status });
});

export default router;
