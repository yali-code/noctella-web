/** Stage 5 W2 intent identity contract. Pure validation only; no DB or writer adoption. */
export interface W2UploadIntent {
  tenantId: string;
  actorId: string;
  productId: string;
  kind: "W2_PRODUCT_PHOTO_UPLOAD";
  token: string;
  sha256: string;
  altText: string;
}
export type W2IdentityDecision = "INVALID" | "NEW" | "SAME_INTENT" | "CONFLICT";
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9:_-]{1,128}$/;
export function isValidW2UploadIntent(value: unknown): value is W2UploadIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ["tenantId", "actorId", "productId"].every(k => typeof v[k] === "string" && SCOPE.test(v[k] as string))
    && v.kind === "W2_PRODUCT_PHOTO_UPLOAD"
    && typeof v.token === "string" && TOKEN.test(v.token)
    && typeof v.sha256 === "string" && SHA256.test(v.sha256)
    && typeof v.altText === "string" && v.altText.length <= 500;
}
const FIELDS = ["tenantId", "actorId", "productId", "kind", "token", "sha256", "altText"] as const;
export function classifyW2UploadIntent(stored: unknown, incoming: unknown): W2IdentityDecision {
  if (!isValidW2UploadIntent(incoming)) return "INVALID";
  if (stored === null) return "NEW";
  if (!isValidW2UploadIntent(stored)) return "CONFLICT";
  return FIELDS.every(field => stored[field] === incoming[field]) ? "SAME_INTENT" : "CONFLICT";
}
