import { api } from "./api";

/** Sanitized connection as returned by the API: never a token or ciphertext. */
export interface InstagramConnection {
  id: string; channel: string; accountLabel: string; externalAccountId: string | null; status: string;
  scopes: string[]; tokenExpiresAt: string | null; updatedAt: string;
}

// The API requires exactly these scopes for the fixed Vault account.
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const base = "/api/instagram/connection";
export const instagramConnectionApi = {
  // Local database read only; never contacts Instagram.
  get: () => api.get<InstagramConnection | null>(base),
  // Explicit operator actions: both call Instagram's read-only identity endpoint (GET /me) and never publish.
  store: (accessToken: string, tokenExpiresAt: string | null) =>
    api.post<InstagramConnection>(base, { accessToken, scopes: INSTAGRAM_SCOPES, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) }),
  verify: () => api.post<InstagramConnection>(`${base}/verify`, {}),
};
