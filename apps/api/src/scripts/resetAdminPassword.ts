import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { adminUsers } from "../db/schema";
import { hashPassword } from "../services/passwordHashing";
import { invalidateAllSessions, normalizeEmail } from "../services/adminAuth";

/**
 * Sprint 64B: CLI-only operator recovery path - no HTTP route, no email flow. Requires
 * infrastructure/deploy-environment access to run. Bumps session_version and deletes existing
 * session rows so every prior session for this user is invalidated immediately. Never prints
 * the password or its hash.
 */
async function main() {
  const email = process.env.RESET_ADMIN_EMAIL;
  const password = process.env.RESET_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("RESET_ADMIN_EMAIL and RESET_ADMIN_PASSWORD are required.");
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error("RESET_ADMIN_PASSWORD must be at least 12 characters.");
    process.exitCode = 1;
    return;
  }

  const normalized = normalizeEmail(email);
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, normalized));
  if (!user) {
    console.error(`No admin user found for ${normalized}.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  await db.update(adminUsers).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(adminUsers.id, user.id));
  await invalidateAllSessions(db, user.id);

  console.log(`Password reset for ${normalized}. All existing sessions for this user were invalidated.`);
}

main().catch((err) => {
  console.error("Password reset failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
