import rateLimit from "express-rate-limit";

/**
 * Bounds password-verification work at the public Admin login entry point. The in-memory store
 * is intentional for the approved single-API-instance production topology. Ten attempts per
 * client per fifteen minutes matches the existing durable failed-login threshold while this
 * HTTP boundary counts every attempt, including malformed requests and successful logins.
 */
export const ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;

export const adminLoginRateLimit = rateLimit({
  windowMs: ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
  limit: ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many login attempts. Please try again later." });
  },
});
