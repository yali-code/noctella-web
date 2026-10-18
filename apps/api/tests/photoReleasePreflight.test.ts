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
    expect(check(result, "migrations.0043").status).toBe("PASS");
    expect(check(result, "migrations.0044").status).toBe("PASS");
    expect(check(result, "migrations.gaps")).toMatchObject({ status: "WARN" });
    expect(check(result, "migrations.gaps").detail).toContain("0039");
    expect(check(result, "migrations.0042-w11")).toMatchObject({ status: "PASS" });
    expect(check(result, "flag.fencing").detail).toContain("OFF");
    expect(check(result, "storage.private-operations").status).toBe("PASS");
    expect(check(result, "storage.publication-staging").status).toBe("PASS");
    expect(["PASS", "WARN"]).toContain(check(result, "publication.exit-authentication").status);
    expect(check(result, "publication.exit-authentication").status).toBe(process.platform === "linux" ? "PASS" : "WARN");
    expect(result.checks.filter((c) => c.status === "MANUAL").map((c) => c.id)).toEqual(["render.single-instance-drain", "publication.restart-attestation", "backups"]);
    expect(result.status).toBe("WARN"); // manual platform steps can never be reported as PASS
    expect(readdirSync(root)).toEqual(["photos"]); // read-only: nothing created
  });

  it("fails on duplicate migration numbers, a missing 0040/0041, a foreign 0042 and an invalid fencing value", () => {
    const root = temp(); mkdirSync(path.join(root, "photos"));
    const result = runPhotoReleasePreflight({ env: { PHOTO_OWNERSHIP_FENCING_ENABLED: "TRUE" }, canonicalRoot: path.join(root, "photos"), migrationsDir: migrations(["0001_a.sql", "0039_etsy.sql", "0039_other.sql", "0040_photo_operation_ownership.sql", "0042_something_else.sql"]) });
    expect(check(result, "migrations.unique-numbers")).toMatchObject({ status: "FAIL" });
    expect(check(result, "migrations.0041").status).toBe("FAIL");
    for (const id of ["migrations.0043", "migrations.0044"]) expect(check(result, id).status).toBe("FAIL"); // protected publication schema (#472)
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

  it("reports low free space and a missing canonical parent", () => {
    const root = temp();
    const low = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "photos"), statfs: () => ({ bavail: 10, bsize: 4096 }) });
    expect(check(low, "storage.free-space").status).toBe("WARN");
    expect(check(low, "storage.canonical-root").status).toBe("WARN");
    const missing = runPhotoReleasePreflight({ env: {}, canonicalRoot: path.join(root, "absent", "photos") });
    expect(check(missing, "storage.private-operations").status).toBe("FAIL");
  });
});
