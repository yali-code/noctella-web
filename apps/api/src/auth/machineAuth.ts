import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Sprint 64B: static bearer token for scheduler-triggered background-job execution.
 * Independent of admin sessions and of the ERP integration key (services/erpIntegration.ts) -
 * never reused across the two. Fails closed: an unset SCHEDULER_AUTH_TOKEN always rejects,
 * rather than allowing the route through unauthenticated.
 */
export function requireSchedulerAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.SCHEDULER_AUTH_TOKEN;
  if (!configured) {
    res.status(401).json({ error: "Scheduler authentication is not configured" });
    return;
  }
  const header = req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    res.status(401).json({ error: "Invalid scheduler credentials" });
    return;
  }
  next();
}
