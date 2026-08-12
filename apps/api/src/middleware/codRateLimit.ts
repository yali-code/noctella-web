import rateLimit from "express-rate-limit";

/**
 * Sprint 135: narrow, route-specific rate limit for the public Cash on Delivery order-creation
 * endpoint only (POST /api/orders/cod) - no other public route is affected. In-memory store
 * (express-rate-limit's default), instance-local by construction: a fresh store is created every
 * time this module is imported/this function is called, matching the existing single-instance
 * SQLite deployment architecture (no Redis/distributed store required or introduced).
 *
 * Policy: 5 requests per client per 10-minute window; the 6th request in the window is rejected.
 * `skipFailedRequests`/`skipSuccessfulRequests` are left at their defaults (false), so every
 * request that reaches this middleware counts toward the limit regardless of whether it later
 * passes validation or business-rule checks - a flood of malformed/rejected attempts is exactly
 * the abuse pattern this exists to bound.
 *
 * Client identity comes from express-rate-limit's default `req.ip`-based keyGenerator, which
 * respects Express's `trust proxy` setting (see app.ts) - correct under Render's single reverse-
 * proxy hop, and does not require a custom keyGenerator.
 */
export const codOrderRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Sprint 135: matches this codebase's existing `{error: message}` route-error contract
  // (see routes/errorHandler.ts) rather than express-rate-limit's default plain-text body.
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many Cash on Delivery order attempts. Please try again later." });
  },
});
