/** FAZ A #424 package G: the read-only photo release preflight (disposable directories only). */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPhotoReleasePreflight } from "../src/scripts/photoReleasePreflight";

const roots: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "noctella-preflight-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const check = (result: ReturnType<typeof runPhotoReleasePreflight>, id: string) => result.checks.find((c) => c.id === id)!;
const migrations = (names: string[]) => { const dir = temp(); for (const name of names) writeFileSync(path.join(dir, name), "-- disposable\n"); return dir; };

describe("photo release preflight", () => {
  it("passes the real candidate inventory, surfacing the 0039 gap and an unregistered 0042", () => {
    const root = temp(); mkdirSync(path.join(root, "photos"));
    const result = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "photos") });
    expect(check(result, "migrations.unique-numbers").status).toBe("PASS");
    expect(check(result, "migrations.0040").status).toBe("PASS");
    expect(check(result, "migrations.0041").status).toBe("PASS");
    // The real inventory must report exactly its missing numbers: 0039 while the Etsy migration is unmerged on this
    // stack, nothing once it lands (#424 migration ordering). Never hard-code the gap.
    const real = readdirSync(path.resolve(__dirname, "../src/db/postgres-migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, 4));
    const missing = Array.from({ length: Math.max(...real.map(Number)) }, (_, i) => String(i + 1).padStart(4, "0")).filter((n) => !real.includes(n));
    expect(check(result, "migrations.gaps").status).toBe(missing.length ? "WARN" : "PASS");
    for (const n of missing) expect(check(result, "migrations.gaps").detail).toContain(n);
    expect(check(result, "migrations.0042-w11")).toMatchObject({ status: "PASS" });
    expect(check(result, "flag.fencing").detail).toContain("OFF");
    expect(check(result, "storage.private-operations").status).toBe("PASS");
    expect(result.checks.filter((c) => c.status === "MANUAL").map((c) => c.id)).toEqual(["render.single-instance-drain", "backups"]);
    expect(result.status).toBe("WARN"); // manual platform steps can never be reported as PASS
    expect(readdirSync(root)).toEqual(["photos"]); // read-only: nothing created
  });

  it("fails on duplicate migration numbers, a missing 0040/0041, a foreign 0042 and an invalid fencing value", () => {
    const root = temp(); mkdirSync(path.join(root, "photos"));
    const result = runPhotoReleasePreflight({ env: { PHOTO_OWNERSHIP_FENCING_ENABLED: "TRUE" }, canonicalRoot: path.join(root, "photos"), migrationsDir: migrations(["0001_a.sql", "0039_etsy.sql", "0039_other.sql", "0040_photo_operation_ownership.sql", "0042_something_else.sql"]) });
    expect(check(result, "migrations.unique-numbers")).toMatchObject({ status: "FAIL" });
    expect(check(result, "migrations.0041").status).toBe("FAIL");
    expect(check(result, "migrations.0042-w11").status).toBe("FAIL");
    expect(check(result, "flag.fencing").status).toBe("FAIL");
    expect(result.status).toBe("FAIL");
  });

  it("flags a registered W11 0042 as requiring recorded owner approval, and W3 requested in production as not activatable", () => {
    const root = temp(); mkdirSync(path.join(root, "photos"));
    const result = runPhotoReleasePreflight({ env: { NODE_ENV: "production", AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED: "true" }, canonicalRoot: path.join(root, "photos"), migrationsDir: migrations(["0040_photo_operation_ownership.sql", "0041_photo_w2_upload_intents.sql", "0042_photo_derivative_operations.sql"]) });
    expect(check(result, "migrations.0042-w11")).toMatchObject({ status: "WARN" });
    expect(check(result, "flag.w3-original-source").status).toBe("WARN");
  });

  it("after the Etsy 0039 merge the inventory is contiguous: no gap, 0040/0041 still required, 0042 still unregistered", () => {
    const root = temp(); mkdirSync(path.join(root, "photos"));
    const names = Array.from({ length: 41 }, (_, i) => `${String(i + 1).padStart(4, "0")}_m.sql`)
      .map((n) => n.startsWith("0039") ? "0039_etsy_listing_form_parity.sql" : n.startsWith("0040") ? "0040_photo_operation_ownership.sql" : n.startsWith("0041") ? "0041_photo_w2_upload_intents.sql" : n);
    const result = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "photos"), migrationsDir: migrations(names) });
    expect(check(result, "migrations.gaps")).toMatchObject({ status: "PASS", detail: "no gaps" });
    expect(check(result, "migrations.unique-numbers").status).toBe("PASS");
    expect([check(result, "migrations.0040").status, check(result, "migrations.0041").status]).toEqual(["PASS", "PASS"]);
    expect(check(result, "migrations.0042-w11").status).toBe("PASS");
  });

  it("fails closed when canonical photos is a separate mounted filesystem from its private staging parent", () => {
    const parent = temp(), canonicalRoot = path.join(parent, "photos");
    mkdirSync(canonicalRoot);
    // Simulate a mount point without requiring privileges, real mounts or any customer data.
    const device = (dir: string) => dir === canonicalRoot ? 42 : dir === parent ? 7 : undefined;
    const result = runPhotoReleasePreflight({ env: {}, canonicalRoot, device });
    expect(check(result, "storage.canonical-root")).toMatchObject({ status: "FAIL" });
    expect(check(result, "storage.canonical-root").detail).toContain("EXDEV");
    expect(check(result, "storage.private-operations").status).toBe("FAIL");
    expect(check(result, "storage.upload-staging").status).toBe("FAIL");
    expect(result.status).toBe("FAIL");
    expect(readdirSync(parent)).toEqual(["photos"]); // preflight remains strictly read-only
  });

  it("accepts a same-device canonical root, parent and not-yet-created private paths", () => {
    const parent = temp(), canonicalRoot = path.join(parent, "photos");
    mkdirSync(canonicalRoot);
    const device = (dir: string) => dir === canonicalRoot || dir === parent ? 7 : undefined;
    const result = runPhotoReleasePreflight({ env: {}, canonicalRoot, device });
    for (const id of ["storage.canonical-root", "storage.private-operations", "storage.upload-staging"])
      expect(check(result, id).status).toBe("PASS");
    expect(readdirSync(parent)).toEqual(["photos"]);
  });

  it("reports low free space and a missing canonical parent", () => {
    const root = temp();
    const low = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "photos"), statfs: () => ({ bavail: 10, bsize: 4096 }) });
    expect(check(low, "storage.free-space").status).toBe("WARN");
    expect(check(low, "storage.canonical-root").status).toBe("WARN");
    const missing = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "absent", "photos") });
    expect(check(missing, "storage.private-operations").status).toBe("FAIL");
  });
});
