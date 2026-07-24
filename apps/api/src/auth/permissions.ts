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
 * Placeholder guard factory. Currently a pass-through - Sprint 64C activates real per-route
 * permission enforcement on top of the authentication boundary requireAuth (below) now provides.
 */
export function requirePermission(_permission: Permission) {
  return (_req: AuthedRequest, _res: Response, next: NextFunction) => {
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
