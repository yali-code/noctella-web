import { NextFunction, Request, Response } from "express";
import { AdminRole, Permission, ROLE_PERMISSIONS } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { parseCookieHeader, SESSION_COOKIE_NAME } from "./cookies";
import { validateSession, type SessionUser } from "../services/adminAuth";

/**
 * Sprint 64B: adminUser is now real, database-backed identity (see
 * services/adminAuth.ts's validateSession) attached by requireAuth below -
 * never trust a client-supplied header for role/identity.
 */
export interface AuthedRequest extends Request {
  adminRole?: AdminRole;
  customerId?: string;
  adminUser?: SessionUser;
}

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Sprint 64C: real per-route authorization, layered on top of requireAuth's authentication
 * boundary. Reads role only from req.adminUser.role (populated exclusively by requireAuth from
 * the database-backed session - never from a client-supplied header) and evaluates it through
 * the shared ROLE_PERMISSIONS model, so Owner's "every permission" access and every other role's
 * grants are represented centrally in @noctella/shared, not hardcoded per route.
 */
export function requirePermission(permission: Permission) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const user = req.adminUser;
    if (!user) {
      // Authenticated identity is unexpectedly absent - requireAuth should always run first and
      // would already have responded 401 in that case. Fails closed with the same status rather
      // than allowing the request through.
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!hasPermission(user.role as AdminRole, permission)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

/**
 * Sprint 64B: the authoritative authentication boundary. Reads only the configured session
 * cookie (never x-admin-role/x-user-role/any client-supplied identity header), validates it
 * end-to-end against the database via validateSession, and attaches the resulting
 * database-backed identity to the request. Responds 401 on any failure to validate.
 */
export function createRequireAuth(db: DbClient) {
  return async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const user = await validateSession(db, token);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.adminUser = user;
    next();
  };
}
