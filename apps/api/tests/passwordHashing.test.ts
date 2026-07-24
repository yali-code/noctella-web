import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/services/passwordHashing";

describe("password hashing (Sprint 64B)", () => {
  it("never stores the plaintext password in the hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse battery staple");
  });

  it("produces a self-describing, versioned stored format with a random salt per call", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b); // different random salts
    expect(a.split(":")[0]).toBe("scrypt");
    expect(a.split(":")).toHaveLength(6);
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("correct-password", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("fails safely (returns false, does not throw) for a malformed stored hash", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt:bad:format")).resolves.toBe(false);
    await expect(verifyPassword("anything", "bcrypt:16384:8:1:aa:bb")).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });
});
