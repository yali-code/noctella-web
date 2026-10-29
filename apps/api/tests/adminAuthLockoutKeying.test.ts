import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createAdminUser, login, LOGIN_RATE_LIMIT_MAX_ATTEMPTS, LOGIN_EMAIL_GLOBAL_MAX_ATTEMPTS } from "../src/services/adminAuth";

function db() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

const GENERIC_MESSAGE = "Invalid email or password";

async function seedActiveUser(d: ReturnType<typeof db>, email = "owner@example.com", password = "correct-password-123") {
  return createAdminUser(d, { email, password, role: "owner" });
}

describe("admin login lockout keying (SEC-A1)", () => {
  it("10 failures for the owner email from IP A do not block a correct login from IP B", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "10.0.0.1" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    const result = await login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "10.0.0.2" });
    expect(result.user.email).toBe("owner@example.com");
  });

  it("10 failures for the owner email from IP A refuse a correct login from the same IP A", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "10.0.0.1" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "10.0.0.1" })).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("50 failures for the owner email spread over 10 IPs (5 each) refuse a correct login from a new IP (backstop)", async () => {
    const d = db();
    await seedActiveUser(d);
    expect(LOGIN_EMAIL_GLOBAL_MAX_ATTEMPTS).toBe(50);
    for (let ip = 1; ip <= 10; ip++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: `10.0.1.${ip}` })).rejects.toThrow(GENERIC_MESSAGE);
      }
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "10.0.1.99" })).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("the IP rule is unchanged: 10 failures from IP A across any emails refuse any login from IP A", async () => {
    const d = db();
    await seedActiveUser(d, "owner@example.com", "correct-password-123");
    await seedActiveUser(d, "second@example.com", "correct-password-456");
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "second@example.com", password: "wrong", ipAddress: "10.0.2.1" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "10.0.2.1" })).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("every refusal path uses the same generic message", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "10.0.3.1" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "10.0.3.1" })).rejects.toThrow(GENERIC_MESSAGE);
    await expect(login(d, { email: "unknown@example.com", password: "whatever" })).rejects.toThrow(GENERIC_MESSAGE);
  });
});
