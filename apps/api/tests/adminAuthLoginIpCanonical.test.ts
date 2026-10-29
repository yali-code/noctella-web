import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { canonicalLoginIp, createAdminUser, login, LOGIN_RATE_LIMIT_MAX_ATTEMPTS } from "../src/services/adminAuth";

function db() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

const GENERIC_MESSAGE = "Invalid email or password";

async function seedActiveUser(d: ReturnType<typeof db>, email = "owner@example.com", password = "correct-password-123") {
  return createAdminUser(d, { email, password, role: "owner" });
}

describe("canonicalLoginIp", () => {
  it("collapses an IPv4-mapped IPv6 address to plain IPv4", () => {
    expect(canonicalLoginIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
  });

  it("is case-insensitive on the ::ffff: prefix", () => {
    expect(canonicalLoginIp("::FFFF:203.0.113.10")).toBe("203.0.113.10");
  });

  it("leaves a plain IPv4 address unchanged", () => {
    expect(canonicalLoginIp("203.0.113.10")).toBe("203.0.113.10");
  });

  it("lower-cases a non-mapped IPv6 address without subnet grouping", () => {
    expect(canonicalLoginIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("returns null for an empty string", () => {
    expect(canonicalLoginIp("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(canonicalLoginIp("  ")).toBeNull();
  });

  it("returns null for null", () => {
    expect(canonicalLoginIp(null)).toBeNull();
  });
});

describe("login lockout keying with IPv4-mapped IPv6 addresses (SEC-A1 fix-up)", () => {
  it("10 failures from the mapped form refuse a correct login from the plain IPv4 form", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "::ffff:203.0.113.10" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "203.0.113.10" })).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("10 failures from the plain IPv4 form refuse a correct login from the mapped form", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "203.0.113.10" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    await expect(login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "::ffff:203.0.113.10" })).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("a correct login from a different IP still succeeds after the above failures", async () => {
    const d = db();
    await seedActiveUser(d);
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await expect(login(d, { email: "owner@example.com", password: "wrong", ipAddress: "203.0.113.10" })).rejects.toThrow(GENERIC_MESSAGE);
    }
    const result = await login(d, { email: "owner@example.com", password: "correct-password-123", ipAddress: "198.51.100.7" });
    expect(result.user.email).toBe("owner@example.com");
  });
});
