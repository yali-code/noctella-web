import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { adminAuthEvents, adminSessions, adminUsers } from "../db/schema";
import { BadRequestError, UnauthorizedError } from "./errors";
import { hashPassword, verifyPassword } from "./passwordHashing";

/** Sprint 64B: centralized session/auth constants - kept small and testable. */
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const LAST_SEEN_UPDATE_THROTTLE_MS = 5 * 60 * 1000; // avoid a write on every single validated request
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;

export type AdminUserStatus = "active" | "disabled";
export type AdminAuthEventType = "login_success" | "login_failed" | "logout" | "session_expired";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  status: AdminUserStatus;
}

const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const generateRawSessionToken = () => crypto.randomBytes(32).toString("base64url");
export const hashSessionToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

async function recordAuthEvent(db: DbClient, input: { adminUserId?: string | null; email: string; eventType: AdminAuthEventType; ipAddress?: string | null; userAgent?: string | null }) {
  await db.insert(adminAuthEvents).values({
    id: id("aae"),
    adminUserId: input.adminUserId ?? null,
    email: input.email,
    eventType: input.eventType,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: iso(now()),
  });
}

async function recentFailedLoginCount(db: DbClient, matcher: { email: string } | { ipAddress: string }, since: string): Promise<number> {
  const clause = "email" in matcher
    ? and(eq(adminAuthEvents.eventType, "login_failed"), eq(adminAuthEvents.email, matcher.email), gt(adminAuthEvents.createdAt, since))
    : and(eq(adminAuthEvents.eventType, "login_failed"), eq(adminAuthEvents.ipAddress, matcher.ipAddress), gt(adminAuthEvents.createdAt, since));
  const rows = await db.select().from(adminAuthEvents).where(clause);
  return rows.length;
}

export interface LoginInput { email: string; password: string; ipAddress?: string | null; userAgent?: string | null }
export interface LoginResult { user: SessionUser; rawToken: string; expiresAt: Date }

/**
 * Always fails with the identical generic message regardless of cause (unknown email, wrong
 * password, disabled account, or rate limiting) - never reveals which case occurred.
 */
export async function login(db: DbClient, input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email ?? "");
  if (!email || !input.password) throw new BadRequestError("Email and password are required");

  const since = iso(new Date(Date.now() - LOGIN_RATE_LIMIT_WINDOW_MS));
  const failuresByEmail = await recentFailedLoginCount(db, { email }, since);
  const failuresByIp = input.ipAddress ? await recentFailedLoginCount(db, { ipAddress: input.ipAddress }, since) : 0;
  if (failuresByEmail >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS || failuresByIp >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
    await recordAuthEvent(db, { email, eventType: "login_failed", ipAddress: input.ipAddress, userAgent: input.userAgent });
    throw new UnauthorizedError("Invalid email or password");
  }

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
  if (!user || user.status !== "active" || !(await verifyPassword(input.password, user.passwordHash))) {
    await recordAuthEvent(db, { adminUserId: user?.id, email, eventType: "login_failed", ipAddress: input.ipAddress, userAgent: input.userAgent });
    throw new UnauthorizedError("Invalid email or password");
  }

  const raw = generateRawSessionToken();
  const tokenHash = hashSessionToken(raw);
  const nowD = now();
  const expiresAt = new Date(nowD.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
  await db.insert(adminSessions).values({
    id: id("asess"),
    tokenHash,
    adminUserId: user.id,
    sessionVersion: user.sessionVersion,
    createdAt: iso(nowD),
    lastSeenAt: iso(nowD),
    expiresAt: iso(expiresAt),
  });
  await db.update(adminUsers).set({ lastLoginAt: iso(nowD), updatedAt: iso(nowD) }).where(eq(adminUsers.id, user.id));
  await recordAuthEvent(db, { adminUserId: user.id, email, eventType: "login_success", ipAddress: input.ipAddress, userAgent: input.userAgent });

  return { user: { id: user.id, email: user.email, role: user.role, status: user.status as AdminUserStatus }, rawToken: raw, expiresAt };
}

/**
 * Validates a raw session token end-to-end: exists, not absolutely expired, not idle-expired,
 * user exists and is active, and the session's captured session_version still matches the live
 * user row (covers forced logout-everywhere via bumpSessionVersion). Never trusts anything but
 * the DB. Deletes the session row when it is no longer valid, and updates last_seen_at only when
 * it is stale enough to be worth a write (throttled, not on every request).
 */
export async function validateSession(db: DbClient, rawToken: string | undefined | null): Promise<SessionUser | null> {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
  const [session] = await db.select().from(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
  if (!session) return null;
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, session.adminUserId));

  const nowMs = Date.now();
  const idleMs = nowMs - Date.parse(session.lastSeenAt);
  const expired = nowMs > Date.parse(session.expiresAt) || idleMs > SESSION_IDLE_TIMEOUT_MS;
  const invalid = !user || user.status !== "active" || user.sessionVersion !== session.sessionVersion;

  if (expired || invalid) {
    await db.delete(adminSessions).where(eq(adminSessions.id, session.id));
    if (expired) await recordAuthEvent(db, { adminUserId: session.adminUserId, email: user?.email ?? "", eventType: "session_expired" });
    return null;
  }

  if (idleMs > LAST_SEEN_UPDATE_THROTTLE_MS) {
    await db.update(adminSessions).set({ lastSeenAt: iso(new Date(nowMs)) }).where(eq(adminSessions.id, session.id));
  }

  return { id: user!.id, email: user!.email, role: user!.role, status: user!.status as AdminUserStatus };
}

/** Safe/idempotent: a missing or already-invalidated session is a no-op, not an error. */
export async function logout(db: DbClient, rawToken: string | undefined | null): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  const [session] = await db.select().from(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
  if (!session) return;
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, session.adminUserId));
  await db.delete(adminSessions).where(eq(adminSessions.id, session.id));
  await recordAuthEvent(db, { adminUserId: session.adminUserId, email: user?.email ?? "", eventType: "logout" });
}

/**
 * Forces every existing session for this user to fail validation on its next use, by bumping
 * session_version (compared live against each session's captured value) and deleting the
 * existing session rows outright. Used by the CLI recovery script and by any future
 * password-change flow - not exposed over HTTP in this sprint.
 */
export async function invalidateAllSessions(db: DbClient, adminUserId: string): Promise<void> {
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, adminUserId));
  if (!user) return;
  await db.update(adminUsers).set({ sessionVersion: user.sessionVersion + 1, updatedAt: iso(now()) }).where(eq(adminUsers.id, adminUserId));
  await db.delete(adminSessions).where(eq(adminSessions.adminUserId, adminUserId));
}

export async function createAdminUser(db: DbClient, input: { email: string; password: string; role: string }): Promise<{ id: string; email: string; role: string }> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const nowIso = iso(now());
  const userId = id("adminuser");
  await db.insert(adminUsers).values({ id: userId, email, passwordHash, role: input.role, status: "active", sessionVersion: 1, createdAt: nowIso, updatedAt: nowIso });
  return { id: userId, email, role: input.role };
}
