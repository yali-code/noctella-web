export const INSTAGRAM_VAULT_ACCOUNT_ID = "28693247390365627";
export const INSTAGRAM_CHANNEL = "instagram";
export const INSTAGRAM_ACCOUNT_LABEL = "vault";
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;

export type InstagramErrorKind =
  | "configuration" | "authentication" | "authorization" | "rate_limit"
  | "invalid_media" | "processing" | "not_found" | "timeout" | "provider" | "unknown";

export class InstagramClientError extends Error {
  constructor(readonly kind: InstagramErrorKind, readonly retryable: boolean) {
    super(`Instagram ${kind.replace("_", " ")} error`);
    this.name = "InstagramClientError";
  }
}

export type InstagramTransport = (url: string, init: RequestInit) => Promise<Response>;

export type InstagramAttemptStatus =
  | "pending" | "container_created" | "processing" | "ready"
  | "publishing" | "published" | "reconciliation_required" | "failed";
