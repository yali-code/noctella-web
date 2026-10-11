/**
 * ADS-009F: redaction-safe failure diagnostics for the scheduled database and product-photo backups.
 * The backup use cases deliberately replace every underlying error with a generic one, so the
 * service layer records - at each step boundary, before that wrapping - ONLY fixed facts:
 * the failing stage, an allowlisted classification code, the numeric HTTP status and an
 * allowlisted S3/network error name. Never: messages, stacks, paths, object keys, bucket names,
 * endpoints, credentials or provider response bodies. The HTTP response stays a generic 503.
 */
export type BackupFailureStage =
  | "CONFIG" | "LOCAL_WORKSPACE" | "LOCAL_SNAPSHOT" | "LOCAL_DB_READ" | "LOCAL_FILE" | "INTEGRITY"
  | "STORAGE_UPLOAD" | "STORAGE_HEAD" | "STORAGE_DOWNLOAD" | "VERIFY_OR_WORKSPACE";
export type BackupFailureCode =
  | "CONFIG_MISSING_OR_INVALID" | "LOCAL_SOURCE_FAILED" | "INTEGRITY_FAILED"
  | "STORAGE_AUTH_REJECTED" | "STORAGE_BUCKET_NOT_FOUND" | "STORAGE_OBJECT_NOT_FOUND" | "STORAGE_NOT_IMPLEMENTED"
  | "STORAGE_BAD_REQUEST" | "STORAGE_ENDPOINT_UNREACHABLE" | "STORAGE_SERVER_ERROR" | "STORAGE_OTHER"
  | "VERIFICATION_OR_WORKSPACE_FAILED";
export interface BackupFailureDiagnostic {
  readonly stage: BackupFailureStage;
  readonly code: BackupFailureCode;
  readonly httpStatus: number | null;
  readonly errorName: string | null;
}

/** Standard S3 / Node error identifiers only - anything else is reported as "OTHER". */
const ERROR_NAME_ALLOWLIST = new Set([
  "AccessDenied", "Forbidden", "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "Unauthorized",
  "NoSuchBucket", "NoSuchKey", "NotFound", "NotImplemented", "AuthorizationHeaderMalformed", "InvalidRequest", "InvalidArgument",
  "InvalidBucketName", "InvalidRegion", "IllegalLocationConstraintException", "PermanentRedirect", "BadRequest", "EntityTooLarge",
  "InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout", "XAmzContentSHA256Mismatch", "BadDigest", "InvalidDigest",
  "TimeoutError", "AbortError", "TypeError",
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPROTO", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_INVALID_URL",
]);
const AUTH = new Set(["AccessDenied", "Forbidden", "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "Unauthorized"]);
const BAD_REQUEST = new Set(["AuthorizationHeaderMalformed", "InvalidRequest", "InvalidArgument", "InvalidBucketName", "InvalidRegion", "IllegalLocationConstraintException", "PermanentRedirect", "BadRequest", "XAmzContentSHA256Mismatch", "BadDigest", "InvalidDigest", "EntityTooLarge"]);
const NETWORK = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPROTO", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_INVALID_URL", "TimeoutError", "AbortError"]);

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; } catch { return undefined; }
}
/** Reads only typed identifiers from an unknown error; never its message. */
function identifiers(error: unknown): { status: number | null; names: string[] } {
  const statusValue = field(field(error, "$metadata"), "httpStatusCode");
  const status = typeof statusValue === "number" && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : null;
  const names = [field(error, "name"), field(error, "Code"), field(error, "code"), field(field(error, "cause"), "code")]
    .filter((v): v is string => typeof v === "string" && ERROR_NAME_ALLOWLIST.has(v));
  return { status, names };
}

export function classifyStorageError(stage: Extract<BackupFailureStage, `STORAGE_${string}`>, error: unknown): BackupFailureDiagnostic {
  const { status, names } = identifiers(error);
  const has = (set: Set<string>) => names.some((n) => set.has(n));
  const code: BackupFailureCode =
    has(AUTH) || status === 401 || status === 403 ? "STORAGE_AUTH_REJECTED"
    : names.includes("NoSuchBucket") ? "STORAGE_BUCKET_NOT_FOUND"
    : names.includes("NotImplemented") || status === 501 ? "STORAGE_NOT_IMPLEMENTED"
    : has(BAD_REQUEST) || status === 400 || status === 301 ? "STORAGE_BAD_REQUEST"
    : names.includes("NoSuchKey") || names.includes("NotFound") || status === 404 ? "STORAGE_OBJECT_NOT_FOUND"
    : has(NETWORK) || (names.includes("TypeError") && status === null) ? "STORAGE_ENDPOINT_UNREACHABLE"
    : status !== null && status >= 500 ? "STORAGE_SERVER_ERROR"
    : "STORAGE_OTHER";
  return { stage, code, httpStatus: status, errorName: names[0] ?? (error === undefined ? null : "OTHER") };
}

/** Thrown by the backup services instead of the use case's generic error; carries only the diagnostic. */
export class BackupFailedError extends Error {
  constructor(readonly diagnostic: BackupFailureDiagnostic) { super("Backup failed"); this.name = "BackupFailedError"; }
}

/** Records the FIRST failure seen at a step boundary; later (wrapped) failures cannot overwrite it. */
export function createDiagnosticRecorder() {
  let first: BackupFailureDiagnostic | null = null;
  return {
    record(d: BackupFailureDiagnostic) { first ??= d; },
    get value() { return first; },
    /** Wraps a storage repository so each method's failure is classified before rethrowing unchanged. */
    storage<R extends { upload: (...a: never[]) => Promise<unknown>; head: (...a: never[]) => Promise<unknown>; download: (...a: never[]) => Promise<unknown> }>(repository: R): R {
      const wrap = <K extends "upload" | "head" | "download">(key: K, stage: Extract<BackupFailureStage, `STORAGE_${string}`>) =>
        (async (...args: never[]) => {
          try { return await (repository[key] as (...a: never[]) => Promise<unknown>)(...args); }
          catch (error) { first ??= classifyStorageError(stage, error); throw error; }
        }) as R[K];
      return { ...repository, upload: wrap("upload", "STORAGE_UPLOAD"), head: wrap("head", "STORAGE_HEAD"), download: wrap("download", "STORAGE_DOWNLOAD") };
    },
    /** Wraps any local step (snapshot, file inspection, DB read, integrity). */
    step<A extends unknown[], T>(stage: BackupFailureStage, code: BackupFailureCode, fn: (...args: A) => T): (...args: A) => T {
      return (...args: A) => {
        try {
          const result = fn(...args);
          if (result instanceof Promise) return result.catch((error: unknown) => { first ??= { stage, code, httpStatus: null, errorName: null }; throw error; }) as T;
          return result;
        } catch (error) { first ??= { stage, code, httpStatus: null, errorName: null }; throw error; }
      };
    },
  };
}

/** One fixed-shape JSON log line; the caller's HTTP response stays generic. */
export function logBackupFailure(event: "database_backup_failed" | "product_photo_backup_failed", error: unknown, log: (line: string) => void = (l) => console.error(l)) {
  const d: BackupFailureDiagnostic = error instanceof BackupFailedError ? error.diagnostic : { stage: "VERIFY_OR_WORKSPACE", code: "VERIFICATION_OR_WORKSPACE_FAILED", httpStatus: null, errorName: null };
  log(JSON.stringify({ event, stage: d.stage, code: d.code, httpStatus: d.httpStatus, errorName: d.errorName }));
}
