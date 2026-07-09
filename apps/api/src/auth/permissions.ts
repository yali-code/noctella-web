import { NextFunction, Request, Response } from "express";
import { AdminRole, Permission, ROLE_PERMISSIONS } from "@noctella/shared";

/**
 * Sprint 1 foundation only. Real session/JWT verification, and actual
 * enforcement of these guards on routes, is out of scope for this sprint.
 */
export interface AuthedRequest extends Request {
  adminRole?: AdminRole;
  customerId?: string;
}

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Placeholder guard factory. Currently a pass-through; wiring this to real
 * auth/session state is future scope.
 */
export function requirePermission(_permission: Permission) {
  return (_req: AuthedRequest, _res: Response, next: NextFunction) => {
    next();
  };
}
