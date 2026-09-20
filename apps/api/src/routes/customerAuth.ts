import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import type { DbClient } from "../db/client";
import { parseCookieHeader } from "../auth/cookies";
import { handleRouteError } from "./errorHandler";
import { createCustomerEmailSender } from "../services/customerEmail";
import { forgotCustomerPassword, loginCustomer, logoutCustomer, registerCustomer, resendVerification, resetCustomerPassword, resolveCustomerSession, verifyCustomerEmail } from "../services/customerIdentity";
import { beginGoogleSignIn, createGoogleProvider, finishGoogleSignIn } from "../services/customerGoogle";
import type { CustomerGoogleProvider } from "../services/customerGoogle";
import type { CustomerEmailSender } from "../services/customerIdentity";
import crypto from "node:crypto";

export const CUSTOMER_COOKIE_NAME = "noctella_customer_session";

function cookieAttributes(): string[] {
  return ["Path=/", "HttpOnly", "SameSite=Lax", ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])];
}
function sessionCookie(token: string, expiresAt: Date): string {
  const seconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [`${CUSTOMER_COOKIE_NAME}=${encodeURIComponent(token)}`, ...cookieAttributes(), `Max-Age=${seconds}`, `Expires=${expiresAt.toUTCString()}`].join("; ");
}
function clearCookie(): string {
  return [`${CUSTOMER_COOKIE_NAME}=`, ...cookieAttributes(), "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"].join("; ");
}
export function customerToken(req: Request): string | undefined {
  return parseCookieHeader(req.headers.cookie)[CUSTOMER_COOKIE_NAME];
}

/** Same-site cookie is primary CSRF defense; explicit configured Origin is defense in depth. */
export function requireCustomerOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.header("origin");
  if (!origin) return next();
  const allowed = (process.env.STOREFRONT_APP_ORIGIN ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowed.includes(origin)) { res.status(403).json({ error: "Request origin is not allowed" }); return; }
  next();
}
export function createCustomerAuthRouter(db: DbClient, sender: CustomerEmailSender = createCustomerEmailSender(), googleProvider: () => CustomerGoogleProvider = createGoogleProvider) {
const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
router.use(requireCustomerOrigin);

router.post("/register", limiter, async (req, res) => {
  try {
    const { email, password, name, termsAccepted } = req.body ?? {};
    res.status(201).json(await registerCustomer(db, sender, { email: String(email ?? ""), password: String(password ?? ""), name: String(name ?? ""), termsAccepted: termsAccepted === true }));
  } catch (error) { handleRouteError(error, res); }
});
router.post("/resend-verification", limiter, async (req, res) => {
  try { res.json(await resendVerification(db, sender, String(req.body?.email ?? ""))); }
  catch (error) { handleRouteError(error, res); }
});
router.post("/verify-email", limiter, async (req, res) => {
  try { res.json(await verifyCustomerEmail(db, String(req.body?.token ?? ""))); }
  catch (error) { handleRouteError(error, res); }
});
router.post("/login", limiter, async (req, res) => {
  try {
    const session = await loginCustomer(db, String(req.body?.email ?? ""), String(req.body?.password ?? ""));
    res.setHeader("Set-Cookie", sessionCookie(session.raw, session.expiresAt));
    res.json({ ok: true });
  } catch (error) { handleRouteError(error, res); }
});
router.get("/me", async (req, res) => {
  try {
    const identity = await resolveCustomerSession(db, customerToken(req));
    if (!identity) return res.status(401).json({ error: "Authentication required" });
    res.json({ customerId: identity.customerId, email: identity.email, name: identity.name });
  } catch (error) { handleRouteError(error, res); }
});
router.post("/logout", async (req, res) => {
  try {
    await logoutCustomer(db, customerToken(req));
    res.setHeader("Set-Cookie", clearCookie());
    res.json({ ok: true });
  } catch (error) { handleRouteError(error, res); }
});
router.post("/forgot-password", limiter, async (req, res) => {
  try { res.json(await forgotCustomerPassword(db, sender, String(req.body?.email ?? ""))); }
  catch (error) { handleRouteError(error, res); }
});
router.post("/reset-password", limiter, async (req, res) => {
  try { res.json(await resetCustomerPassword(db, String(req.body?.token ?? ""), String(req.body?.password ?? ""))); }
  catch (error) { handleRouteError(error, res); }
});

router.get("/google/start", limiter, async (_req, res) => {
  try {
    const attempt = await beginGoogleSignIn(db, googleProvider());
    res.setHeader("Set-Cookie", [`noctella_google_state=${attempt.state}`, "Path=/api/customer-auth/google", "HttpOnly", "SameSite=Lax", ...(process.env.NODE_ENV === "production" ? ["Secure"] : []), "Max-Age=600"].join("; "));
    res.redirect(302, attempt.url);
  }
  catch {
    const storefront = (process.env.STOREFRONT_APP_ORIGIN ?? "").split(",")[0];
    if (!storefront) return res.status(503).json({ error: "Google sign-in is temporarily unavailable" });
    res.redirect(302, new URL("/account?google=unavailable", storefront).toString());
  }
});
router.get("/google/callback", limiter, async (req, res) => {
  const storefront = (process.env.STOREFRONT_APP_ORIGIN ?? "").split(",")[0];
  try {
    if (!storefront) throw new Error("Storefront origin is not configured");
    if (req.query.error) throw new Error("Google authorization failed");
    const state = String(req.query.state ?? "");
    const cookieState = parseCookieHeader(req.headers.cookie).noctella_google_state;
    if (!cookieState || cookieState.length !== state.length || !crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(state))) throw new Error("Google state mismatch");
    const session = await finishGoogleSignIn(db, googleProvider(), state, String(req.query.code ?? ""));
    res.setHeader("Set-Cookie", [sessionCookie(session.raw, session.expiresAt), "noctella_google_state=; Path=/api/customer-auth/google; HttpOnly; SameSite=Lax; Max-Age=0"]);
    res.redirect(302, new URL("/account", storefront).toString());
  } catch {
    res.setHeader("Set-Cookie", "noctella_google_state=; Path=/api/customer-auth/google; HttpOnly; SameSite=Lax; Max-Age=0");
    if (!storefront) return res.status(503).json({ error: "Google sign-in is temporarily unavailable" });
    res.redirect(302, new URL("/account?google=unavailable", storefront).toString());
  }
});

return router;
}
