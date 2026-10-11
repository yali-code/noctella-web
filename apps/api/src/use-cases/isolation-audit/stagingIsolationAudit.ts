import path from "node:path";
import { z } from "zod";

/**
 * ADS-009D: pure, read-only staging/production isolation audit (E02). No I/O, no network, no
 * database, no environment access. The operator supplies SEPARATELY SOURCED effective-runtime
 * snapshots in a trusted context; this function only compares them and returns, per check,
 * PASS / FAIL / UNKNOWN with a FIXED reason code. Input values are never echoed: not in results,
 * not in errors, not as digests. A snapshot that is not marked effective_runtime (e.g. copied from
 * render.yaml) can never yield PASS.
 */

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2048);
const yesNo = z.enum(["YES", "NO"]);
const storage = z.object({ endpoint: text.optional(), region: text.optional(), bucket: text.optional(), prefix: z.string().trim().max(512).optional() }).strict();
const environment = z.object({
  /** Where the values were read. Only "effective_runtime" (live service settings) can support PASS. */
  source: z.enum(["effective_runtime", "blueprint", "unknown"]),
  apiServiceId: id.optional(),
  otherServiceIds: z.array(id).max(20).optional(),
  diskId: id.optional(),
  diskAttachedToServiceId: id.optional(),
  diskMountPath: text.optional(),
  databaseUrl: text.optional(),
  productPhotoDir: text.optional(),
  mediaAssetDir: text.optional(),
  databaseBackup: storage.optional(),
  photoBackup: storage.optional(),
  origins: z.object({ adminAppOrigin: text.optional(), storefrontAppOrigin: text.optional(), publicApiOrigin: text.optional(), nextPublicApiBaseUrl: text.optional(), cookieDomain: text.optional() }).strict().optional(),
}).strict();
export const isolationAuditInputSchema = z.object({
  expected: z.object({ stagingApiServiceId: id.optional(), stagingDiskId: id.optional(), productionDiskId: id.optional(), stagingOriginSuffix: text.optional() }).strict().optional(),
  staging: environment,
  production: environment,
  stagingCrons: z.array(z.object({
    serviceId: id,
    source: z.enum(["effective_runtime", "blueprint", "unknown"]),
    /** How API_HOSTPORT is set on the live cron: Blueprint fromService binding, or a manual dashboard value. */
    apiHostportSetting: z.enum(["fromService", "manual_override", "unknown"]),
    boundServiceId: id.optional(),
    schedulerTokenSetting: z.enum(["fromService", "manual_override", "unknown"]),
  }).strict()).max(20).optional(),
  /** Facts the tool cannot prove offline; answered by a human operator. */
  operatorAttestations: z.object({
    stagingDatabaseBackupCredentialDeniedOnProductionBucket: yesNo.optional(),
    stagingPhotoBackupCredentialDeniedOnProductionBucket: yesNo.optional(),
    productionDiskNotAttachedToAnyStagingService: yesNo.optional(),
  }).strict().optional(),
}).strict();
export type IsolationAuditInput = z.infer<typeof isolationAuditInputSchema>;
type Env = IsolationAuditInput["staging"];

export type CheckStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface IsolationCheck { readonly id: string; readonly title: string; readonly severity: "required" | "advisory"; readonly status: CheckStatus; readonly reason: string }

const runtime = (e: Env) => e.source === "effective_runtime";
const posixInside = (child: string, parent: string) => {
  const c = path.posix.normalize(child), p = path.posix.normalize(parent).replace(/\/+$/, "");
  return p.length > 0 && c.startsWith(`${p}/`);
};
const hostOf = (value: string | undefined) => { if (!value) return null; try { return new URL(value).hostname.toLowerCase(); } catch { return null; } };
/** Bucket identity = storage account host (or AWS region) + bucket name. Prefixes are NOT identity. */
function bucketIdentity(s: z.infer<typeof storage> | undefined): string | null {
  if (!s?.bucket) return null;
  const account = s.endpoint ? hostOf(s.endpoint) : s.region ? `aws:${s.region.toLowerCase()}` : null;
  return account ? `${account}\u0000${s.bucket}` : null;
}
const normPrefix = (p: string | undefined, fallback: string) => (p?.trim() || fallback).replace(/^\/+|\/+$/g, "");
const prefixesOverlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function auditStagingIsolation(input: IsolationAuditInput) {
  const { staging: s, production: p } = input;
  const exp = input.expected ?? {};
  const att = input.operatorAttestations ?? {};
  const both = runtime(s) && runtime(p);
  const checks: IsolationCheck[] = [];
  const add = (check: IsolationCheck) => checks.push(check);
  const unknown = (idv: string, title: string, severity: IsolationCheck["severity"], reason: string) => add({ id: idv, title, severity, status: "UNKNOWN", reason });

  // I01 provenance
  add({ id: "I01", title: "Snapshots come from effective runtime settings", severity: "required",
    status: both ? "PASS" : "UNKNOWN", reason: both ? "BOTH_EFFECTIVE_RUNTIME" : "NOT_EFFECTIVE_RUNTIME_NO_PASS_FROM_BLUEPRINT" });

  // I02 service identity
  {
    const t = "Staging and production services are distinct";
    const sIds = [s.apiServiceId, ...(s.otherServiceIds ?? [])].filter(Boolean) as string[];
    const pIds = [p.apiServiceId, ...(p.otherServiceIds ?? [])].filter(Boolean) as string[];
    if (!both || !s.apiServiceId || !p.apiServiceId) unknown("I02", t, "required", "SERVICE_IDS_MISSING_OR_NOT_RUNTIME");
    else if (sIds.some((x) => pIds.includes(x))) add({ id: "I02", title: t, severity: "required", status: "FAIL", reason: "SERVICE_ID_SHARED" });
    else if (exp.stagingApiServiceId && s.apiServiceId !== exp.stagingApiServiceId) add({ id: "I02", title: t, severity: "required", status: "FAIL", reason: "STAGING_API_NOT_EXPECTED_SERVICE" });
    else add({ id: "I02", title: t, severity: "required", status: "PASS", reason: "SERVICE_IDS_DISJOINT" });
  }

  // I03 disk identity
  {
    const t = "Staging API uses its own disk, distinct from production";
    if (!both || !s.diskId || !p.diskId) unknown("I03", t, "required", "DISK_IDS_MISSING_OR_NOT_RUNTIME");
    else if (s.diskId === p.diskId) add({ id: "I03", title: t, severity: "required", status: "FAIL", reason: "DISK_SHARED" });
    else if ((exp.stagingDiskId && s.diskId !== exp.stagingDiskId) || (exp.productionDiskId && p.diskId !== exp.productionDiskId)) add({ id: "I03", title: t, severity: "required", status: "FAIL", reason: "DISK_NOT_EXPECTED_ID" });
    else if (!s.diskAttachedToServiceId || !s.apiServiceId) unknown("I03", t, "required", "DISK_ATTACHMENT_UNKNOWN");
    else if (s.diskAttachedToServiceId !== s.apiServiceId) add({ id: "I03", title: t, severity: "required", status: "FAIL", reason: "STAGING_DISK_NOT_ON_STAGING_API" });
    else add({ id: "I03", title: t, severity: "required", status: "PASS", reason: "DISKS_DISTINCT_AND_ATTACHED" });
  }

  // I04 effective DATABASE_URL on the staging disk (an identical in-volume path is acceptable)
  {
    const t = "Staging DATABASE_URL resolves inside the staging disk mount";
    if (!runtime(s) || !s.databaseUrl || !s.diskMountPath) unknown("I04", t, "required", "DATABASE_URL_OR_MOUNT_UNKNOWN");
    else if (!path.posix.isAbsolute(s.databaseUrl) || !posixInside(s.databaseUrl, s.diskMountPath)) add({ id: "I04", title: t, severity: "required", status: "FAIL", reason: "DATABASE_URL_OUTSIDE_STAGING_MOUNT" });
    else add({ id: "I04", title: t, severity: "required", status: "PASS", reason: "DATABASE_URL_ON_STAGING_DISK" });
  }

  // I05 photo/media directories on the staging disk
  {
    const t = "Staging photo and media directories are on the staging disk";
    const dirs = [s.productPhotoDir, s.mediaAssetDir];
    if (!runtime(s) || !s.diskMountPath || dirs.some((d) => !d)) unknown("I05", t, "required", "PHOTO_OR_MEDIA_DIR_UNKNOWN");
    else if (dirs.some((d) => !posixInside(d!, s.diskMountPath!))) add({ id: "I05", title: t, severity: "required", status: "FAIL", reason: "DIRECTORY_OUTSIDE_STAGING_MOUNT" });
    else add({ id: "I05", title: t, severity: "required", status: "PASS", reason: "DIRECTORIES_ON_STAGING_DISK" });
  }

  // I06-I09 backup destinations: bucket identity (required) and prefix overlap (advisory) are separate.
  for (const [bucketId, prefixId, label, key, fallback] of [
    ["I06", "I07", "database backup", "databaseBackup", "database-backups"],
    ["I08", "I09", "product-photo backup", "photoBackup", "product-photo-backups"],
  ] as const) {
    const sb = s[key], pb = p[key];
    const bt = `Staging ${label} bucket is a different bucket from production`;
    const si = bucketIdentity(sb), pi = bucketIdentity(pb);
    if (!both || !si || !pi) unknown(bucketId, bt, "required", "BUCKET_IDENTITY_UNKNOWN");
    else if (si === pi) add({ id: bucketId, title: bt, severity: "required", status: "FAIL", reason: "SAME_BUCKET_PREFIX_SEPARATION_IS_NOT_ISOLATION" });
    else add({ id: bucketId, title: bt, severity: "required", status: "PASS", reason: "DIFFERENT_BUCKET_IDENTITY" });
    const pt = `Staging ${label} prefix does not overlap production's`;
    if (!both || !sb || !pb) unknown(prefixId, pt, "advisory", "PREFIX_UNKNOWN");
    else if (prefixesOverlap(normPrefix(sb.prefix, fallback), normPrefix(pb.prefix, fallback))) add({ id: prefixId, title: pt, severity: "advisory", status: "FAIL", reason: "PREFIX_OVERLAP_NO_ENVIRONMENT_MARKER" });
    else add({ id: prefixId, title: pt, severity: "advisory", status: "PASS", reason: "PREFIXES_DISJOINT" });
  }

  // I10 staging cron bindings
  {
    const t = "Every staging cron targets the staging API via Blueprint binding (no manual override)";
    const crons = input.stagingCrons ?? [];
    if (!crons.length || !s.apiServiceId) unknown("I10", t, "required", "CRON_BINDINGS_UNKNOWN");
    else if (crons.some((c) => c.apiHostportSetting === "manual_override" || c.schedulerTokenSetting === "manual_override")) add({ id: "I10", title: t, severity: "required", status: "FAIL", reason: "MANUAL_OVERRIDE_PRESENT" });
    else if (crons.some((c) => c.source === "effective_runtime" && c.boundServiceId && (c.boundServiceId !== s.apiServiceId || c.boundServiceId === p.apiServiceId))) add({ id: "I10", title: t, severity: "required", status: "FAIL", reason: "CRON_BOUND_TO_NON_STAGING_API" });
    else if (crons.some((c) => c.source !== "effective_runtime" || c.apiHostportSetting !== "fromService" || c.schedulerTokenSetting !== "fromService" || !c.boundServiceId)) unknown("I10", t, "required", "CRON_BINDING_NOT_PROVEN_AT_RUNTIME");
    else add({ id: "I10", title: t, severity: "required", status: "PASS", reason: "CRONS_BOUND_TO_STAGING_API" });
  }

  // I11 origins
  {
    const t = "Staging origins are staging hosts and differ from production";
    const suffix = (exp.stagingOriginSuffix ?? ".staging.noctella.com").toLowerCase();
    const so = s.origins ?? {}, po = p.origins ?? {};
    const sHosts = [so.adminAppOrigin, so.storefrontAppOrigin, so.publicApiOrigin, so.nextPublicApiBaseUrl].map(hostOf);
    const pHosts = [po.adminAppOrigin, po.storefrontAppOrigin, po.publicApiOrigin, po.nextPublicApiBaseUrl].map(hostOf).filter(Boolean) as string[];
    if (!runtime(s) || sHosts.some((h) => !h) || !so.cookieDomain) unknown("I11", t, "required", "STAGING_ORIGINS_UNKNOWN");
    else if (sHosts.some((h) => !h!.endsWith(suffix)) || so.cookieDomain.toLowerCase() !== suffix) add({ id: "I11", title: t, severity: "required", status: "FAIL", reason: "NON_STAGING_ORIGIN" });
    else if (sHosts.some((h) => pHosts.includes(h!)) || (po.cookieDomain && po.cookieDomain.toLowerCase() === so.cookieDomain.toLowerCase())) add({ id: "I11", title: t, severity: "required", status: "FAIL", reason: "ORIGIN_SHARED_WITH_PRODUCTION" });
    else add({ id: "I11", title: t, severity: "required", status: "PASS", reason: "STAGING_ORIGINS_ISOLATED" });
  }

  // I12-I14 operator-only facts (the tool never calls storage or Render)
  for (const [idv, title, value, yes, no] of [
    ["I12", "Staging database-backup credential is denied on the production bucket", att.stagingDatabaseBackupCredentialDeniedOnProductionBucket, "OPERATOR_ATTESTED_ACCESS_DENIED", "OPERATOR_REPORTED_ACCESS_ALLOWED"],
    ["I13", "Staging photo-backup credential is denied on the production bucket", att.stagingPhotoBackupCredentialDeniedOnProductionBucket, "OPERATOR_ATTESTED_ACCESS_DENIED", "OPERATOR_REPORTED_ACCESS_ALLOWED"],
    ["I14", "Production disk is not attached to any staging service", att.productionDiskNotAttachedToAnyStagingService, "OPERATOR_ATTESTED", "OPERATOR_REPORTED_ATTACHED"],
  ] as const) {
    add({ id: idv, title, severity: "required", status: value === "YES" ? "PASS" : value === "NO" ? "FAIL" : "UNKNOWN", reason: value === "YES" ? yes : value === "NO" ? no : "OPERATOR_ATTESTATION_REQUIRED" });
  }

  const required = checks.filter((c) => c.severity === "required");
  const overall: CheckStatus = required.some((c) => c.status === "FAIL") ? "FAIL" : required.every((c) => c.status === "PASS") ? "PASS" : "UNKNOWN";
  return {
    tool: "ADS-009D staging isolation audit" as const,
    overall,
    // E02 is never upgraded beyond what direct evidence shows; FAIL blocks, UNKNOWN stays PARTIAL.
    e02Gate: overall === "PASS" ? "PASS_PENDING_REVIEW" as const : overall === "FAIL" ? "BLOCKED" as const : "PARTIAL" as const,
    checks,
    operatorActionsRequired: checks.filter((c) => c.status === "UNKNOWN").map((c) => c.id),
    valuesPrinted: false as const,
  };
}

/** Parses untrusted operator JSON; any problem yields a fixed error with no input content. */
export function parseIsolationAuditInput(raw: string): { ok: true; input: IsolationAuditInput } | { ok: false; error: "INPUT_NOT_JSON" | "INPUT_SCHEMA_INVALID" | "INPUT_TOO_LARGE" } {
  if (raw.length > 64_000) return { ok: false, error: "INPUT_TOO_LARGE" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: "INPUT_NOT_JSON" }; }
  const parsed = isolationAuditInputSchema.safeParse(value);
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, error: "INPUT_SCHEMA_INVALID" };
}
