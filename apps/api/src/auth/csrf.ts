import type { NextFunction, Request, Response } from "express";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedAdminOrigins(): string[] {
  return (process.env.ADMIN_APP_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Defense-in-depth alongside SameSite=Lax, which is the primary CSRF protection for the
 * cookie-authenticated admin API. Rejects a state-changing request whose Origin header is
 * present but does not match a configured admin app origin. A request with no Origin header is
 * not rejected here (many legitimate non-browser/test/server-to-server callers omit it) - the
 * actual cross-site browser attack this exists to catch always sends an Origin header.
 */
export function requireAdminOriginForMutations(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const origin = req.header("origin");
  if (!origin) return next();
  const allowed = allowedAdminOrigins();
  if (allowed.length > 0 && !allowed.includes(origin)) {
    res.status(403).json({ error: "Request origin is not allowed" });
    return;
  }
  next();
}
