/**
 * FAZ A #463 - INACTIVE PROPOSAL: not imported by production code. Decision rules for review before any
 * owner-approved wiring into photoOperationAuthority (W2/W4) or the gated W11 owner. No I/O, no side effects.
 *
 * F3 - an existing canonical file at the operation's key (link() returned EEXIST) may be adopted only when it is
 * provably this operation's own earlier publication: same bytes as the current seal AND the inode of one of this
 * operation's sealed generations (0040 keeps every generation's sealed dev/ino in photo_operation_artifacts).
 * Equal bytes alone do not establish ownership. W11/0042 cannot use this yet: reclaim clears seal_* and the
 * generations table keeps no per-generation seal (see FAZ_A_F3_F5_RECOVERY_CLOSURE_463.md).
 *
 * F4 - failures are classified by what a retry can achieve, never collapsed into "invalid media".
 */
export interface ArtifactIdentity { sha256: string; dev: string; ino: string }
export type ExistingCanonicalDecision =
  | "ADOPT_OWN_GENERATION"
  | "REVIEW_FOREIGN_SAME_BYTES"
  | "REVIEW_OWN_GENERATION_DIFFERENT_BYTES"
  | "REVIEW_DIFFERENT_BYTES";

const sameInode = (a: ArtifactIdentity, b: ArtifactIdentity) => a.dev === b.dev && a.ino === b.ino;

export function classifyExistingCanonical(
  existing: ArtifactIdentity,
  currentSeal: ArtifactIdentity,
  ownSeals: readonly ArtifactIdentity[],
): ExistingCanonicalDecision {
  const own = sameInode(existing, currentSeal) || ownSeals.some((seal) => sameInode(existing, seal) && seal.sha256 === existing.sha256);
  if (existing.sha256 === currentSeal.sha256) return own ? "ADOPT_OWN_GENERATION" : "REVIEW_FOREIGN_SAME_BYTES";
  return own ? "REVIEW_OWN_GENERATION_DIFFERENT_BYTES" : "REVIEW_DIFFERENT_BYTES";
}

export type FailureClass = "RETRYABLE" | "CONFIGURATION" | "OPERATOR_REVIEW" | "INVALID_INPUT";
export type FailureStage = "source" | "storage" | "database" | "ownership";

/** Transient resource/infrastructure conditions: the same request can succeed later. */
const RETRYABLE_SYSTEM_CODES = new Set(["EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EINTR", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]);
/** Deployment faults: retrying cannot help until an operator fixes the environment; never "invalid media". */
const CONFIGURATION_SYSTEM_CODES = new Set(["EXDEV", "EACCES", "EPERM", "EROFS", "ENOTDIR", "ELOOP"]);
const RETRYABLE_OWNERSHIP_CODES = new Set(["PHOTO_OPERATION_IN_PROGRESS", "PHOTO_OPERATION_FENCE_LOST", "W11_OPERATION_IN_PROGRESS", "W11_OPERATION_FENCE_LOST"]);
const REVIEW_OWNERSHIP_CODES = new Set(["PHOTO_OPERATION_REVIEW", "PHOTO_OPERATION_CONFLICT", "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT", "W11_OPERATION_REVIEW", "W11_OPERATION_CONFLICT"]);

export function classifyPhotoOperationFailure(stage: FailureStage, error: unknown): FailureClass {
  const code = typeof (error as any)?.code === "string" ? (error as any).code as string : undefined;
  const message = String((error as any)?.message ?? "");
  if (code && RETRYABLE_OWNERSHIP_CODES.has(code)) return "RETRYABLE";
  if (code && REVIEW_OWNERSHIP_CODES.has(code)) return "OPERATOR_REVIEW";
  if (/^(UNSUPPORTED_PHOTO_OWNERSHIP_DRIVER|PHOTO_OWNERSHIP_DRIVER_MISMATCH|PHOTO_CANONICAL_ROOT_MISMATCH)/.test(message)) return "CONFIGURATION";
  if (stage === "database") {
    // Missing ownership schema (SQLite "no such table", PostgreSQL 42P01) is a deployment fault, not bad media.
    if (code === "42P01" || /no such table/i.test(message)) return "CONFIGURATION";
    // PostgreSQL connection / admin shutdown / serialization classes are transient.
    if (code && (/^08/.test(code) || /^57P0[1-3]$/.test(code) || code === "40001" || code === "40P01")) return "RETRYABLE";
    if (/SQLITE_BUSY|database is locked/i.test(`${code ?? ""} ${message}`)) return "RETRYABLE";
  }
  if (code && RETRYABLE_SYSTEM_CODES.has(code)) return "RETRYABLE";
  if (code && CONFIGURATION_SYSTEM_CODES.has(code)) return "CONFIGURATION";
  // Only the caller's own source (already validated by readRegularLocalFile) can make the media itself invalid.
  if (stage === "source" && (code === "ENOENT" || (error as any)?.kind === "invalid_media")) return "INVALID_INPUT";
  // Unknown: fail closed without claiming the media is invalid and without unbounded automatic retries.
  return "OPERATOR_REVIEW";
}

/** Proposed mapping onto the existing Instagram caller contract (kind, retryable); unchanged kinds only. */
export function instagramErrorFor(failure: FailureClass): { kind: "processing" | "invalid_media"; retryable: boolean } {
  if (failure === "INVALID_INPUT") return { kind: "invalid_media", retryable: false };
  if (failure === "OPERATOR_REVIEW") return { kind: "processing", retryable: false };
  return { kind: "processing", retryable: true }; // RETRYABLE and CONFIGURATION (alert operators; media is not at fault)
}

/**
 * The publication root a W11 owner call must use: the caller's validated `root`. Divergence from the owner's own
 * default (F4 / C3) is a configuration fault, never a silent fallback to productPhotoStaticRoot.
 */
export function assertSameCanonicalRoot(callerRoot: string, ownerRoot: string, resolve: (p: string) => string): void {
  if (resolve(callerRoot) !== resolve(ownerRoot)) throw new Error("PHOTO_CANONICAL_ROOT_MISMATCH");
}
