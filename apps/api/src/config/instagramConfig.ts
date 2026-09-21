import { isIP } from "node:net";
import { InstagramClientError, INSTAGRAM_VAULT_ACCOUNT_ID } from "../integrations/instagram/types";

export function assertVaultPolicy(env: NodeJS.ProcessEnv = process.env): void {
  const configured = (env.INSTAGRAM_ALLOWED_ACCOUNT_IDS ?? INSTAGRAM_VAULT_ACCOUNT_ID).split(",").map((id) => id.trim());
  if (configured.length !== 1 || configured[0] !== INSTAGRAM_VAULT_ACCOUNT_ID) throw new InstagramClientError("configuration", false);
}

function allowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  // Configure only controlled, public media origins. Meta fetches the URL; DNS and
  // redirects at that origin remain an operational trust boundary, not an API fetch.
  const hosts = (env.INSTAGRAM_MEDIA_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.some((host) => host === "localhost" || host.endsWith(".localhost") || isIP(host) !== 0 || !/^[a-z0-9.-]+$/.test(host))) {
    throw new InstagramClientError("configuration", false);
  }
  return new Set(hosts);
}

export function validateInstagramMediaUrl(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const hosts = allowedHosts(env);
  if (hosts.size === 0) throw new InstagramClientError("configuration", false);
  if (typeof value !== "string" || value.length > 4096) throw new InstagramClientError("invalid_media", false);
  let url: URL;
  try { url = new URL(value); } catch { throw new InstagramClientError("invalid_media", false); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") || isIP(url.hostname) !== 0 ||
      !hosts.has(url.hostname)) throw new InstagramClientError("invalid_media", false);
  return url.toString();
}
