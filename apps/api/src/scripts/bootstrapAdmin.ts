import { AdminRole } from "@noctella/shared";
import { db } from "../db/client";
import { adminUsers } from "../db/schema";
import { createAdminUser } from "../services/adminAuth";

/**
 * Sprint 64B: creates the first Owner admin only when admin_users is empty - safe to re-run
 * (no-ops rather than duplicating or erroring once any admin exists). Never prints the password
 * or its hash. No HTTP route - infrastructure/CLI access only, per npm run bootstrap:admin.
 */
async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required.");
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.");
    process.exitCode = 1;
    return;
  }

  const existing = await db.select().from(adminUsers).limit(1);
  if (existing.length > 0) {
    console.log("An admin user already exists - bootstrap is a safe no-op.");
    return;
  }

  const created = await createAdminUser(db, { email, password, role: AdminRole.Owner });
  console.log(`Created first admin user ${created.email} with role ${created.role}.`);
}

main().catch((err) => {
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
