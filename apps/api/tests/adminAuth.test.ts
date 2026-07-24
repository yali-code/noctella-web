import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import {
  createAdminUser,
  generateRawSessionToken,
  hashSessionToken,
  invalidateAllSessions,
  login,
  logout,
  normalizeEmail,
  validateSession,
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from "../src/services/adminAuth";
import { UnauthorizedError, BadRequestError } from "../src/services/errors";

function db() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

beforeEach(() => vi.restoreAllMocks());

describe("admin schema (Sprint 64B)", () => {
  it("creates admin_users/admin_sessions/admin_auth_events tables via ensureSchema", async () => {
    const d = db();
    await expect(d.select().from(schema.adminUsers)).resolves.toEqual([]);
    await expect(d.select().from(schema.adminSessions)).resolves.toEqual([]);
    await expect(d.select().from(schema.adminAuthEvents)).resolves.toEqual([]);
  });

  it("normalizes and enforces a unique email at the application layer", async () => {
    const d = db();
    await createAdminUser(d, { email: "Owner@Example.com", password: "correct-password-123", role: "owner" });
    await expect(createAdminUser(d, { email: "owner@example.com", password: "another-password-1", role: "owner" })).rejects.toThrow();
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  Ada@Example.com  ")).toBe("ada@example.com");
  });
});

describe("login (Sprint 64B)", () => {
  async function seedActiveUser(d: ReturnType<typeof db>, email = "owner@example.com", password = "correct-password-123") {
    return createAdminUser(d, { email, password, role: "owner" });
  }

  it("succeeds for a correct email/password, creates a session row, sets last_login_at, records login_success", async () => {
    const d = db();
    await seedActiveUser(d);
    const result = await login(d, { email: "Owner@Example.com", password: "correct-password-123", ipAddress: "1.2.3.4", userAgent: "vitest" });
    expect(result.user.email).toBe("owner@example.com");
    expect(result.rawToken).toBeTruthy();

    const sessions = await d.select().from(schema.adminSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toBe(hashSessionToken(result.rawToken));
    expect(sessions[0].tokenHash).not.toBe(result.rawToken); // raw token is never stored

    const [user] = await d.select().from(schema.adminUsers);
    expect(user.lastLoginAt).toBeTruthy();

    const events = await d.select().from(schema.adminAuthEvents);
    expect(events.some((e) => e.eventType === "login_success")).toBe(true);
  });

  it("rejects an unknown email with the generic error", async () => {
    const d = db();
    await seedActiveUser(d);
    await expect(login(d, { email: "nobody@example.com", password: "whatever-password" })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(login(d, { email: "nobody@example.com", password: "whatever-password" })).rejects.toThrow("Invalid email or password");
  });

  it("rejects the wrong password with the identical generic error", async () => {
    const d = db();
    await seedActiveUser(d);
    await expect(login(d, { email: "owner@example.com", password: "wrong-password-here" })).rejects.toThrow("Invalid email or password");
  });

  it("rejects a disabled user with the identical generic error, not a distinct message", async () => {
    const d = db();
    const created = await seedActiveUser(d);
    await d.update(schema.adminUsers).set({ status: "disabled" }).where(eq(schema.adminUsers.id, created.id));
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123" })).rejects.toThrow("Invalid email or password");
  });

  it("rejects missing email/password as a malformed request", async () => {
    const d = db();
    await expect(login(d, { email: "", password: "" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("records a login_failed event and never creates a session on any failure path", async () => {
    const d = db();
    await seedActiveUser(d);
    await expect(login(d, { email: "owner@example.com", password: "wrong" })).rejects.toThrow();
    expect(await d.select().from(schema.adminSessions)).toHaveLength(0);
    const events = await d.select().from(schema.adminAuthEvents);
    expect(events.some((e) => e.eventType === "login_failed")).toBe(true);
  });

  it("rate-limits repeated failures by normalized email within the window, still with the generic error", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong" })).rejects.toThrow("Invalid email or password");
    }
    // Even the *correct* password is now rejected because the email is rate-limited.
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123" })).rejects.toThrow("Invalid email or password");
  });

  it("rate-limits repeated failures by IP address within the window", async () => {
    const d = db();
    await seedActiveUser(d);
    await seedActiveUser(d, "second@example.com", "correct-password-456");
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "second@example.com", password: "wrong", ipAddress: "9.9.9.9" })).rejects.toThrow();
    }
    // A different, previously-unattempted account from the same throttled IP is also blocked.
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "9.9.9.9" })).rejects.toThrow("Invalid email or password");
  });
});

describe("session validation (Sprint 64B)", () => {
  async function seedSession(d: ReturnType<typeof db>) {
    const created = await createAdminUser(d, { email: "owner@example.com", password: "correct-password-123", role: "owner" });
    const result = await login(d, { email: "owner@example.com", password: "correct-password-123" });
    return { user: created, rawToken: result.rawToken };
  }

  it("validates a fresh session and returns the database-backed user", async () => {
    const d = db();
    const { rawToken } = await seedSession(d);
    const user = await validateSession(d, rawToken);
    expect(user).toMatchObject({ email: "owner@example.com", role: "owner", status: "active" });
  });

  it("returns null for a missing token", async () => {
    const d = db();
    await seedSession(d);
    expect(await validateSession(d, undefined)).toBeNull();
    expect(await validateSession(d, "")).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const d = db();
    await seedSession(d);
    expect(await validateSession(d, generateRawSessionToken())).toBeNull();
  });

  it("returns null and deletes the row once absolutely expired", async () => {
    const d = db();
    const { rawToken } = await seedSession(d);
    const tokenHash = hashSessionToken(rawToken);
    const past = new Date(Date.now() - SESSION_ABSOLUTE_LIFETIME_MS - 1000).toISOString();
    await d.update(schema.adminSessions).set({ expiresAt: past }).where(eq(schema.adminSessions.tokenHash, tokenHash));
    expect(await validateSession(d, rawToken)).toBeNull();
    expect(await d.select().from(schema.adminSessions)).toHaveLength(0);
  });

  it("returns null once idle-expired even though still within absolute lifetime", async () => {
    const d = db();
    const { rawToken } = await seedSession(d);
    const tokenHash = hashSessionToken(rawToken);
    const staleLastSeen = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000).toISOString();
    await d.update(schema.adminSessions).set({ lastSeenAt: staleLastSeen }).where(eq(schema.adminSessions.tokenHash, tokenHash));
    expect(await validateSession(d, rawToken)).toBeNull();
  });

  it("returns null for a disabled user even with an otherwise-valid session", async () => {
    const d = db();
    const { rawToken, user } = await seedSession(d);
    await d.update(schema.adminUsers).set({ status: "disabled" }).where(eq(schema.adminUsers.id, user.id));
    expect(await validateSession(d, rawToken)).toBeNull();
  });

  it("returns null when session_version no longer matches the live user row (forced invalidation)", async () => {
    const d = db();
    const { rawToken, user } = await seedSession(d);
    await invalidateAllSessions(d, user.id);
    expect(await validateSession(d, rawToken)).toBeNull();
  });

  it("logout deletes the session and records a logout event", async () => {
    const d = db();
    const { rawToken } = await seedSession(d);
    await logout(d, rawToken);
    expect(await d.select().from(schema.adminSessions)).toHaveLength(0);
    const events = await d.select().from(schema.adminAuthEvents);
    expect(events.some((e) => e.eventType === "logout")).toBe(true);
    expect(await validateSession(d, rawToken)).toBeNull();
  });

  it("logout is safe/idempotent when the session is already missing", async () => {
    const d = db();
    await seedSession(d);
    await expect(logout(d, generateRawSessionToken())).resolves.toBeUndefined();
    await expect(logout(d, undefined)).resolves.toBeUndefined();
  });

  it("invalidateAllSessions deletes every session row for the user immediately", async () => {
    const d = db();
    const { user } = await seedSession(d);
    const second = await login(d, { email: "owner@example.com", password: "correct-password-123" });
    expect(await d.select().from(schema.adminSessions)).toHaveLength(2);
    await invalidateAllSessions(d, user.id);
    expect(await d.select().from(schema.adminSessions)).toHaveLength(0);
    expect(await validateSession(d, second.rawToken)).toBeNull();
  });
});
