import { resolveMarketplaceRequestTimeoutMs } from "../../config/marketplaceConfig";
import { InstagramClientError, INSTAGRAM_VAULT_ACCOUNT_ID, type InstagramTransport } from "./types";

function apiVersion(env: NodeJS.ProcessEnv): string {
  const value = env.INSTAGRAM_API_VERSION?.trim();
  if (!value || !/^v\d{1,2}\.\d{1,2}$/.test(value)) throw new InstagramClientError("configuration", false);
  return value;
}

function providerError(status: number): InstagramClientError {
  if (status === 401) return new InstagramClientError("authentication", false);
  if (status === 403) return new InstagramClientError("authorization", false);
  if (status === 404) return new InstagramClientError("not_found", false);
  if (status === 429) return new InstagramClientError("rate_limit", true);
  if (status === 400 || status === 422) return new InstagramClientError("invalid_media", false);
  return new InstagramClientError(status >= 500 ? "provider" : "unknown", status >= 500);
}

/** Only Instagram Login's fixed Graph host is accepted; no arbitrary endpoint configuration. */
export class InstagramClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(private readonly accessToken: string, private readonly transport: InstagramTransport = fetch, env: NodeJS.ProcessEnv = process.env) {
    if (!accessToken) throw new InstagramClientError("configuration", false);
    this.base = `https://graph.instagram.com/${apiVersion(env)}`;
    this.timeoutMs = resolveMarketplaceRequestTimeoutMs(env);
  }

  private async request(path: string, method: "GET" | "POST", fields?: Record<string, string>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.accessToken}`, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw providerError(response.status);
      const body: unknown = await response.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InstagramClientError("provider", false);
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InstagramClientError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new InstagramClientError("timeout", true);
      throw new InstagramClientError("provider", true);
    } finally { clearTimeout(timer); }
  }

  async verifyAccount(): Promise<{ id: string; username: string }> {
    const account = await this.request("/me?fields=id%2Cusername", "GET");
    if (account.id !== INSTAGRAM_VAULT_ACCOUNT_ID || typeof account.username !== "string") throw new InstagramClientError("authorization", false);
    return { id: INSTAGRAM_VAULT_ACCOUNT_ID, username: account.username };
  }

  async createImageContainer(instagramAccountId: string, imageUrl: string, caption: string): Promise<string> {
    if (instagramAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID) throw new InstagramClientError("authorization", false);
    const body = await this.request(`/${INSTAGRAM_VAULT_ACCOUNT_ID}/media`, "POST", { image_url: imageUrl, caption });
    if (typeof body.id !== "string" || !body.id) throw new InstagramClientError("provider", false);
    return body.id;
  }

  async getContainerStatus(containerId: string): Promise<string> {
    if (!/^\d+$/.test(containerId)) throw new InstagramClientError("configuration", false);
    const body = await this.request(`/${containerId}?fields=status_code`, "GET");
    if (typeof body.status_code !== "string") throw new InstagramClientError("provider", false);
    return body.status_code;
  }

  async publishContainer(instagramAccountId: string, containerId: string): Promise<string> {
    if (instagramAccountId !== INSTAGRAM_VAULT_ACCOUNT_ID || !/^\d+$/.test(containerId)) throw new InstagramClientError("authorization", false);
    const body = await this.request(`/${INSTAGRAM_VAULT_ACCOUNT_ID}/media_publish`, "POST", { creation_id: containerId });
    if (typeof body.id !== "string" || !body.id) throw new InstagramClientError("provider", false);
    return body.id;
  }
}
