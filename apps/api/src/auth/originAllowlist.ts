/**
 * Sprint 135 correction: the single, shared definition of "does this environment variable's raw
 * value contain at least one usable configured origin" - extracted so app.ts's CORS allowlist and
 * services/readiness.ts's origin-configured checks can never silently disagree again. Pure
 * (no environment read of its own) so both call sites remain free to pass whatever value is
 * appropriate (real process.env, or a test-supplied env object).
 *
 * A comma-separated value normalizes exactly like the CORS allowlist already did before this
 * correction: split on commas, trim each segment, drop empty segments. A whole-string trim alone
 * (the pre-correction readiness behavior) is not equivalent - "," ,"" would trim to a non-empty
 * string ",,," while containing zero usable origins once split and filtered.
 */
export function parseConfiguredOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
