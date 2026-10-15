/**
 * #390 Stage 2: AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED switch for the original-source W3 writer.
 *
 * Unset, "" or "false" -> OFF. Only the exact string "true" requests it; any other value is reported invalid and
 * stays OFF (this switch enables new behaviour, so the safe default is the established WebP-first writer).
 *
 * Not activatable outside NODE_ENV "test"/"development": stored originals keep EXIF/GPS/camera-serial metadata
 * in private staging, and the retention contract for open intakes is an unresolved owner decision (#390 design,
 * docs/architecture/W3_ORIGINAL_SOURCE_STAGING_DESIGN.md). Lifting this fence requires that approval.
 */
const ACTIVATABLE_ENVIRONMENTS = ["test", "development"];

export function aiIntakeOriginalSourceStagingConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; requested: boolean; valid: boolean; activatable: boolean } {
  const raw = env.AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED;
  const requested = raw === "true";
  const valid = raw === undefined || raw === "" || raw === "false" || raw === "true";
  const activatable = ACTIVATABLE_ENVIRONMENTS.includes(env.NODE_ENV ?? "");
  return { enabled: requested && activatable, requested, valid, activatable };
}

export const aiIntakeOriginalSourceStagingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => aiIntakeOriginalSourceStagingConfig(env).enabled;
