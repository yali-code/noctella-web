import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function inboundRequestId(req: Request): string | undefined {
  const value = req.header(REQUEST_ID_HEADER)?.trim();
  return value && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

function safeRouteClassification(req: Request, routePath: unknown): string {
  if (typeof routePath !== "string" || !routePath.startsWith("/")) return "UNMATCHED";
  // Express assigns req.route after entering the mounted router and before invoking its route
  // middleware. At that exact point baseUrl and route.path are both trusted routing metadata.
  const baseUrl = req.baseUrl;
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/|$))*$/.test(baseUrl) && baseUrl !== "") return "UNMATCHED";
  if (!/^\/(?:[A-Za-z0-9._~:-]+(?:\/|$))*$/.test(routePath)) return "UNMATCHED";
  return `${baseUrl}${routePath}`.replace(/\/{2,}/g, "/");
}

export function requestObservability(req: Request, res: Response, next: NextFunction): void {
  const requestId = inboundRequestId(req) ?? crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  // Request-local interception of Express's normal req.route assignment captures the complete
  // template before a nested router can unwind via next(error), or before a delayed response ends.
  // The backing value preserves ordinary req.route reads/writes; no handler/next/response method is
  // wrapped. A later valid route assignment may replace an earlier candidate (e.g. next("route")),
  // while unwind itself performs no assignment and therefore cannot degrade the stored template.
  let currentRoute = req.route;
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => currentRoute,
    set: (value: unknown) => {
      currentRoute = value;
      const classification = safeRouteClassification(req, (value as { path?: unknown } | undefined)?.path);
      if (classification !== "UNMATCHED") res.locals.routeClassification = classification;
    },
  });

  res.once("finish", () => {
    if (res.locals.routeClassification === undefined) {
      res.locals.routeClassification = "UNMATCHED";
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const entry = {
      event: "request_complete",
      requestId,
      method: req.method,
      route: typeof res.locals.routeClassification === "string" ? res.locals.routeClassification : "UNMATCHED",
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      category: res.statusCode >= 500 ? "server_error" : res.statusCode >= 400 ? "client_error" : "success",
    };
    // Fixed-field JSON only: headers, cookies, credentials, query values, and request bodies are
    // deliberately never read or serialized here.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  });
  next();
}

export function logUnhandledRequestError(res: Response): void {
  // Never inspect the exception: upstream messages can contain credentials or personal data.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    event: "request_error",
    requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : "unavailable",
    category: "unhandled",
  }));
}
