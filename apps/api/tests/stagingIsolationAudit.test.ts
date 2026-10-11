// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditStagingIsolation, parseIsolationAuditInput, type IsolationAuditInput } from "../src/use-cases/isolation-audit/stagingIsolationAudit";
import { runIsolationAuditCli } from "../src/scripts/auditStagingIsolation";

/**
 * ADS-009D: in-memory, redaction-safe harness. Every fixture value is synthetic; markers named
 * SENSITIVE-* stand in for values that must never appear in tool output.
 */
const isolated = (): IsolationAuditInput => ({
  expected: { stagingApiServiceId: "srv-staging-api", stagingDiskId: "dsk-staging", productionDiskId: "dsk-production" },
  staging: {
    source: "effective_runtime", apiServiceId: "srv-staging-api", otherServiceIds: ["srv-staging-admin", "crn-staging-backup"],
    diskId: "dsk-staging", diskAttachedToServiceId: "srv-staging-api", diskMountPath: "/var/data",
    databaseUrl: "/var/data/noctella.sqlite", productPhotoDir: "/var/data/product-photos", mediaAssetDir: "/var/data/media-assets",
    databaseBackup: { endpoint: "https://SENSITIVE-staging-account.r2.example", region: "auto", bucket: "SENSITIVE-staging-db-bucket", prefix: "staging/database-backups" },
    photoBackup: { endpoint: "https://SENSITIVE-staging-account.r2.example", region: "auto", bucket: "SENSITIVE-staging-photo-bucket", prefix: "staging/product-photo-backups" },
    origins: { adminAppOrigin: "https://admin.staging.noctella.com", storefrontAppOrigin: "https://shop.staging.noctella.com", publicApiOrigin: "https://api.staging.noctella.com", nextPublicApiBaseUrl: "https://api.staging.noctella.com", cookieDomain: ".staging.noctella.com" },
  },
  production: {
    source: "effective_runtime", apiServiceId: "srv-production-api", otherServiceIds: ["srv-production-admin"],
    diskId: "dsk-production", diskAttachedToServiceId: "srv-production-api", diskMountPath: "/var/data",
    databaseUrl: "/var/data/noctella.sqlite",
    databaseBackup: { endpoint: "https://SENSITIVE-production-account.r2.example", region: "auto", bucket: "SENSITIVE-production-db-bucket", prefix: "database-backups" },
    photoBackup: { endpoint: "https://SENSITIVE-production-account.r2.example", region: "auto", bucket: "SENSITIVE-production-photo-bucket", prefix: "product-photo-backups" },
    origins: { adminAppOrigin: "https://admin.noctella.com", storefrontAppOrigin: "https://shop.noctella.com", publicApiOrigin: "https://api.noctella.com", nextPublicApiBaseUrl: "https://api.noctella.com", cookieDomain: ".noctella.com" },
  },
  stagingCrons: ["crn-staging-backup", "crn-staging-photos", "crn-staging-jobs", "crn-staging-analytics"].map((serviceId) => ({
    serviceId, source: "effective_runtime" as const, apiHostportSetting: "fromService" as const, boundServiceId: "srv-staging-api", schedulerTokenSetting: "fromService" as const,
  })),
  operatorAttestations: { stagingDatabaseBackupCredentialDeniedOnProductionBucket: "YES", stagingPhotoBackupCredentialDeniedOnProductionBucket: "YES", productionDiskNotAttachedToAnyStagingService: "YES" },
});
const status = (r: ReturnType<typeof auditStagingIsolation>, idv: string) => r.checks.find((c) => c.id === idv)!;
type Patch = (i: IsolationAuditInput) => void;
const run = (patch: Patch) => { const i = isolated(); patch(i); return auditStagingIsolation(i); };

describe("ADS-009D isolation audit: verdicts", () => {
  it("passes only a fully isolated, effective-runtime, operator-attested snapshot", () => {
    const r = auditStagingIsolation(isolated());
    expect(r.overall).toBe("PASS");
    expect(r.e02Gate).toBe("PASS_PENDING_REVIEW");
    expect(r.checks.filter((c) => c.status !== "PASS").map((c) => c.id)).toEqual([]);
    expect(r.operatorActionsRequired).toEqual([]);
  });

  it("never yields PASS from Blueprint-sourced or unknown snapshots, even with identical good values", () => {
    for (const source of ["blueprint", "unknown"] as const) {
      const r = run((i) => { i.staging.source = source; i.stagingCrons = i.stagingCrons!.map((c) => ({ ...c, source })); });
      expect(r.overall).toBe("UNKNOWN");
      expect(r.e02Gate).toBe("PARTIAL");
      for (const idv of ["I01", "I02", "I03", "I04", "I05", "I06", "I08", "I10", "I11"]) expect(status(r, idv).status, idv).toBe("UNKNOWN");
    }
  });

  it("treats a shared bucket as FAIL even when prefixes differ (prefix separation is not isolation)", () => {
    const r = run((i) => { i.staging.databaseBackup = { ...i.production.databaseBackup!, prefix: "staging/database-backups" }; });
    expect(status(r, "I06")).toMatchObject({ status: "FAIL", reason: "SAME_BUCKET_PREFIX_SEPARATION_IS_NOT_ISOLATION" });
    expect(status(r, "I07").status).toBe("PASS");
    expect(r.overall).toBe("FAIL");
    expect(r.e02Gate).toBe("BLOCKED");
    // Host comparison is case-insensitive: the same account written differently is still the same bucket.
    const cased = run((i) => { i.staging.photoBackup = { ...i.production.photoBackup!, endpoint: i.production.photoBackup!.endpoint!.toUpperCase(), prefix: "x" }; });
    expect(status(cased, "I08").status).toBe("FAIL");
  });

  it("treats the same bucket name in a different storage account as a different bucket", () => {
    const r = run((i) => { i.staging.databaseBackup = { ...i.staging.databaseBackup!, bucket: i.production.databaseBackup!.bucket }; });
    expect(status(r, "I06").status).toBe("PASS");
  });

  it("reports overlapping prefixes as an advisory FAIL without failing the overall verdict", () => {
    for (const prefix of ["database-backups", "/database-backups/", "database-backups/nested", undefined]) {
      const r = run((i) => { i.staging.databaseBackup!.prefix = prefix; });
      expect(status(r, "I07")).toMatchObject({ severity: "advisory", status: "FAIL", reason: "PREFIX_OVERLAP_NO_ENVIRONMENT_MARKER" });
      expect(r.overall).toBe("PASS");
    }
  });

  it("fails shared or unexpected disks and services", () => {
    expect(status(run((i) => { i.staging.diskId = "dsk-production"; }), "I03").reason).toBe("DISK_SHARED");
    expect(status(run((i) => { i.staging.diskId = "dsk-other"; }), "I03").reason).toBe("DISK_NOT_EXPECTED_ID");
    expect(status(run((i) => { i.staging.diskAttachedToServiceId = "srv-production-api"; }), "I03").reason).toBe("STAGING_DISK_NOT_ON_STAGING_API");
    expect(status(run((i) => { i.staging.otherServiceIds = ["srv-production-admin"]; }), "I02").reason).toBe("SERVICE_ID_SHARED");
    expect(status(run((i) => { i.staging.apiServiceId = "srv-unexpected"; i.staging.diskAttachedToServiceId = "srv-unexpected"; }), "I02").reason).toBe("STAGING_API_NOT_EXPECTED_SERVICE");
  });

  it("accepts the same in-volume DATABASE_URL path but fails paths that escape the staging mount", () => {
    expect(status(auditStagingIsolation(isolated()), "I04").status).toBe("PASS"); // same path as production, own disk
    for (const databaseUrl of ["/var/database/noctella.sqlite", "/var/data/../prod/noctella.sqlite", "./data/noctella.sqlite", "/var/data"]) {
      expect(status(run((i) => { i.staging.databaseUrl = databaseUrl; }), "I04").status, databaseUrl).toBe("FAIL");
    }
    expect(status(run((i) => { i.staging.productPhotoDir = "/mnt/production/photos"; }), "I05").status).toBe("FAIL");
  });

  it("fails manual cron overrides or bindings to a non-staging API, and stays UNKNOWN when unproven", () => {
    expect(status(run((i) => { i.stagingCrons![0]!.apiHostportSetting = "manual_override"; }), "I10").reason).toBe("MANUAL_OVERRIDE_PRESENT");
    expect(status(run((i) => { i.stagingCrons![1]!.schedulerTokenSetting = "manual_override"; }), "I10").reason).toBe("MANUAL_OVERRIDE_PRESENT");
    expect(status(run((i) => { i.stagingCrons![2]!.boundServiceId = "srv-production-api"; }), "I10").reason).toBe("CRON_BOUND_TO_NON_STAGING_API");
    expect(status(run((i) => { i.stagingCrons![3]!.apiHostportSetting = "unknown"; }), "I10").status).toBe("UNKNOWN");
    expect(status(run((i) => { delete i.stagingCrons; }), "I10").status).toBe("UNKNOWN");
  });

  it("fails non-staging or production-shared origins", () => {
    expect(status(run((i) => { i.staging.origins!.publicApiOrigin = "https://api.noctella.com"; }), "I11").reason).toBe("NON_STAGING_ORIGIN");
    expect(status(run((i) => { i.staging.origins!.cookieDomain = ".noctella.com"; }), "I11").reason).toBe("NON_STAGING_ORIGIN");
    expect(status(run((i) => { i.production.origins!.adminAppOrigin = "https://admin.staging.noctella.com"; }), "I11").reason).toBe("ORIGIN_SHARED_WITH_PRODUCTION");
    expect(status(run((i) => { i.staging.origins!.storefrontAppOrigin = "https://shop.staging.noctella.com.evil.example"; }), "I11").status).toBe("FAIL");
  });

  it("uses operator attestations for facts the tool cannot prove, listing missing ones as actions", () => {
    const missing = run((i) => { delete i.operatorAttestations; });
    expect(["I12", "I13", "I14"].map((x) => status(missing, x).status)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    expect(missing.overall).toBe("UNKNOWN");
    expect(missing.operatorActionsRequired).toEqual(["I12", "I13", "I14"]);
    const no = run((i) => { i.operatorAttestations!.stagingDatabaseBackupCredentialDeniedOnProductionBucket = "NO"; });
    expect(status(no, "I12")).toMatchObject({ status: "FAIL", reason: "OPERATOR_REPORTED_ACCESS_ALLOWED" });
    expect(no.overall).toBe("FAIL");
  });
});

describe("ADS-009D CLI: redaction and side-effect safety", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const cli = async (args: string[], input: string | (() => Promise<string>)) => {
    const out: string[] = [], err: string[] = [];
    const code = await runIsolationAuditCli(args, typeof input === "string" ? async () => input : input, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const SENSITIVE = /SENSITIVE|r2\.example|srv-|crn-|dsk-|\/var\/data|staging\.noctella|noctella\.sqlite/;

  it("prints only ids, statuses and reason codes - no input values, hosts, paths or digests", async () => {
    for (const [input, code] of [[isolated(), 0], [{ ...isolated(), staging: { ...isolated().staging, diskId: "dsk-production" } }, 1], [{ ...isolated(), operatorAttestations: {} }, 2]] as const) {
      const r = await cli([], JSON.stringify(input));
      expect(r.code).toBe(code);
      expect(r.err).toBe("");
      expect(r.out).not.toMatch(SENSITIVE);
      expect(r.out).not.toMatch(/[0-9a-f]{12,}/); // no hashes or truncated digests
      const parsed = JSON.parse(r.out);
      expect(Object.keys(parsed).sort()).toEqual(["checks", "e02Gate", "operatorActionsRequired", "overall", "tool", "valuesPrinted"]);
      for (const c of parsed.checks) expect(Object.keys(c).sort()).toEqual(["id", "reason", "severity", "status", "title"]);
    }
  });

  it("rejects credentials or unexpected fields fail-closed without echoing them", async () => {
    const withSecret = isolated() as unknown as { staging: { databaseBackup: Record<string, string> } };
    withSecret.staging.databaseBackup.secretAccessKey = "SENSITIVE-secret-access-key-value";
    const r = await cli([], JSON.stringify(withSecret));
    expect(r).toMatchObject({ code: 1, out: "", err: "ISOLATION_AUDIT_ERROR: INPUT_SCHEMA_INVALID" });
    expect(r.err).not.toMatch(SENSITIVE);
  });

  it("never echoes malformed input, oversized input, read failures or argv values", async () => {
    expect(await cli([], "{ SENSITIVE-not-json")).toMatchObject({ code: 1, out: "", err: "ISOLATION_AUDIT_ERROR: INPUT_NOT_JSON" });
    expect(await cli([], `"${"x".repeat(70_000)}SENSITIVE"`)).toMatchObject({ code: 1, err: "ISOLATION_AUDIT_ERROR: INPUT_TOO_LARGE" });
    expect(await cli([], async () => { throw new Error("SENSITIVE stdin failure"); })).toMatchObject({ code: 1, err: "ISOLATION_AUDIT_ERROR: INPUT_UNREADABLE" });
    const argv = await cli(["--bucket=SENSITIVE-bucket"], JSON.stringify(isolated()));
    expect(argv.code).toBe(1);
    expect(argv.err).not.toMatch(SENSITIVE);
    expect(argv.out).toBe("");
  });

  it("performs no network or database access", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("network must not be used"); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    vi.doMock("../src/db/client", () => { throw new Error("db/client must not be imported"); });
    try {
      const { runIsolationAuditCli: fresh } = await import("../src/scripts/auditStagingIsolation");
      const code = await fresh([], async () => JSON.stringify(isolated()), () => undefined, () => undefined);
      expect(code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.doUnmock("../src/db/client"); }
  });

  it("parser contract: fixed error codes only", () => {
    expect(parseIsolationAuditInput("[]")).toEqual({ ok: false, error: "INPUT_SCHEMA_INVALID" });
    expect(parseIsolationAuditInput("nope")).toEqual({ ok: false, error: "INPUT_NOT_JSON" });
  });
});

describe("ADS-009E: prior operator attestations and an unset PUBLIC_API_ORIGIN", () => {
  // The state recorded in #335 (Render inventory + operator YES answers), expressed without any
  // bucket name, path or credential: IDs are Render metadata, the rest are YES/NO attestations.
  const recorded = (): IsolationAuditInput => ({
    expected: { stagingApiServiceId: "srv-staging-api", stagingDiskId: "dsk-staging", productionDiskId: "dsk-production" },
    staging: { source: "effective_runtime", apiServiceId: "srv-staging-api", otherServiceIds: ["crn-staging-backup"], diskId: "dsk-staging", diskAttachedToServiceId: "srv-staging-api", origins: { publicApiOrigin: "UNSET" } },
    production: { source: "effective_runtime", apiServiceId: "srv-production-api", diskId: "dsk-production" },
    operatorAttestations: { stagingDatabaseUrlOnStagingDisk: "YES", databaseBackupBucketsDistinct: "YES", photoBackupBucketsDistinct: "YES", stagingOriginsAreStagingOnly: "YES" },
  });

  it("represents the recorded evidence and leaves only the genuinely unknown checks open", () => {
    const r = auditStagingIsolation(recorded());
    expect(r.overall).toBe("UNKNOWN");
    expect(r.e02Gate).toBe("PARTIAL");
    expect(Object.fromEntries(r.checks.map((c) => [c.id, c.status]))).toEqual({
      I01: "PASS", I02: "PASS", I03: "PASS", I04: "PASS", I05: "UNKNOWN", I06: "PASS", I07: "UNKNOWN", I08: "PASS", I09: "UNKNOWN",
      I10: "UNKNOWN", I11: "PASS", I12: "UNKNOWN", I13: "UNKNOWN", I14: "UNKNOWN",
    });
    expect(status(r, "I11").reason).toBe("OPERATOR_ATTESTED_STAGING_ORIGINS_PUBLIC_API_ORIGIN_UNSET_FAIL_CLOSED");
    expect(status(r, "I06").reason).toBe("OPERATOR_ATTESTED_DISTINCT_BUCKETS");
    const closed = auditStagingIsolation({ ...recorded(), operatorAttestations: { ...recorded().operatorAttestations, stagingPhotoAndMediaDirsOnStagingDisk: "YES", stagingCronsLinkedToStagingApiWithoutOverride: "YES",
      stagingDatabaseBackupCredentialDeniedOnProductionBucket: "YES", stagingPhotoBackupCredentialDeniedOnProductionBucket: "YES", productionDiskNotAttachedToAnyStagingService: "YES" } });
    expect(closed.overall).toBe("PASS");
    expect(closed.e02Gate).toBe("PASS_PENDING_REVIEW");
    expect(closed.operatorActionsRequired).toEqual(["I07", "I09"]); // advisory prefixes only
  });

  it("supplied values always take precedence over an attestation", () => {
    const sharedBucket = run((i) => { i.staging.databaseBackup = { ...i.production.databaseBackup!, prefix: "staging" }; i.operatorAttestations = { ...i.operatorAttestations, databaseBackupBucketsDistinct: "YES" }; });
    expect(status(sharedBucket, "I06").reason).toBe("SAME_BUCKET_PREFIX_SEPARATION_IS_NOT_ISOLATION");
    const prodOrigin = run((i) => { i.staging.origins = { adminAppOrigin: "https://admin.noctella.com", publicApiOrigin: "UNSET" }; i.operatorAttestations = { ...i.operatorAttestations, stagingOriginsAreStagingOnly: "YES" }; });
    expect(status(prodOrigin, "I11").reason).toBe("NON_STAGING_ORIGIN");
    const outside = run((i) => { i.staging.databaseUrl = "/var/other/noctella.sqlite"; i.operatorAttestations = { ...i.operatorAttestations, stagingDatabaseUrlOnStagingDisk: "YES" }; });
    expect(status(outside, "I04").status).toBe("FAIL");
  });

  it("an unset PUBLIC_API_ORIGIN is fail-closed and passes with complete staging origins; an unreported one stays UNKNOWN", () => {
    expect(status(run((i) => { i.staging.origins!.publicApiOrigin = "UNSET"; }), "I11")).toMatchObject({ status: "PASS", reason: "STAGING_ORIGINS_ISOLATED_PUBLIC_API_ORIGIN_UNSET_FAIL_CLOSED" });
    const missing = auditStagingIsolation({ ...recorded(), staging: { ...recorded().staging, origins: {} } });
    expect(status(missing, "I11")).toMatchObject({ status: "UNKNOWN", reason: "PUBLIC_API_ORIGIN_UNKNOWN" });
    expect(status(run((i) => { i.staging.origins!.publicApiOrigin = "not-a-url"; }), "I11").reason).toBe("NON_STAGING_ORIGIN");
  });

  it("a NO attestation fails, and attestations never upgrade non-runtime snapshots", () => {
    const no = auditStagingIsolation({ ...recorded(), operatorAttestations: { ...recorded().operatorAttestations, photoBackupBucketsDistinct: "NO" } });
    expect(status(no, "I08")).toMatchObject({ status: "FAIL", reason: "OPERATOR_REPORTED_FAIL" });
    expect(no.e02Gate).toBe("BLOCKED");
    const blueprint = auditStagingIsolation({ ...recorded(), staging: { ...recorded().staging, source: "blueprint" } });
    for (const idv of ["I04", "I06", "I08", "I10", "I11"]) expect(status(blueprint, idv).status, idv).toBe("UNKNOWN");
  });
});
