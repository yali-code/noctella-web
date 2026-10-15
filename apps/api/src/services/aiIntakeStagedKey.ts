/**
 * #390 Stage 1: the staged AI-intake photo key generations, recognised in one place.
 *
 * - "legacy-webp": `${uuid}.webp`, the live W3 writer's full-resolution WebP (already metadata-free).
 * - "original": `${uuid}.orig.(jpg|png|webp)`, a validated upload stored unchanged; it can carry EXIF/GPS/serial
 *   metadata and must never leave the private store except through the metadata-free preview.
 * - `.${uuid}.partial`: an unpublished original-source write (never referenced by a database row).
 *
 * No writer produces "original" keys yet; this module only lets readers and cleanup recognise them safely.
 * The UUID shape is identical to use-cases/ai-intake-cleanup's canonical lowercase server-generated id.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEGACY_STAGED_KEY_RE = new RegExp(`^${UUID}\\.webp$`);
const ORIGINAL_STAGED_KEY_RE = new RegExp(`^${UUID}\\.orig\\.(jpg|png|webp)$`);
const STAGED_PARTIAL_RE = new RegExp(`^\\.${UUID}\\.partial$`);
const ORIGINAL_FORMATS = { jpg: "jpeg", png: "png", webp: "webp" } as const;

export type StagedKeyGeneration =
  | { generation: "legacy-webp"; format: "webp" }
  | { generation: "original"; format: "jpeg" | "png" | "webp" };

export function parseStagedKey(key: string): StagedKeyGeneration | null {
  if (LEGACY_STAGED_KEY_RE.test(key)) return { generation: "legacy-webp", format: "webp" };
  const original = ORIGINAL_STAGED_KEY_RE.exec(key);
  if (original) return { generation: "original", format: ORIGINAL_FORMATS[original[1] as keyof typeof ORIGINAL_FORMATS] };
  return null;
}

export const isOriginalSourceStagedKey = (key: string) => ORIGINAL_STAGED_KEY_RE.test(key);
export const isStagedPartialFilename = (name: string) => STAGED_PARTIAL_RE.test(name);

const ORIGINAL_EXTENSIONS = { "image/jpeg": { ext: "jpg", format: "jpeg" }, "image/png": { ext: "png", format: "png" }, "image/webp": { ext: "webp", format: "webp" } } as const;
export type OriginalSourceMimeType = keyof typeof ORIGINAL_EXTENSIONS;

/** Original-source key for a verified upload format (`${uuid}.orig.(jpg|png|webp)`), or null for any other MIME type. */
export function originalSourceKeyParts(mimetype: string): { ext: string; format: "jpeg" | "png" | "webp" } | null {
  return Object.prototype.hasOwnProperty.call(ORIGINAL_EXTENSIONS, mimetype) ? ORIGINAL_EXTENSIONS[mimetype as OriginalSourceMimeType] : null;
}

/** MIME type of a staged source for W4: the verified original format, or image/webp (unchanged) for every other key. */
export function stagedSourceMimeType(key: string): OriginalSourceMimeType {
  const parsed = parseStagedKey(key);
  if (parsed?.generation !== "original") return "image/webp";
  return parsed.format === "jpeg" ? "image/jpeg" : parsed.format === "png" ? "image/png" : "image/webp";
}
