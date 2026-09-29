/** Required only when generating public API URLs; never inferred from request headers. */
export function resolvePublicApiOrigin(env: Record<string, string | undefined> = process.env): string {
  const value = env.PUBLIC_API_ORIGIN?.trim();
  try {
    // Reject paths before URL normalization can erase dot segments or backslashes.
    if (!value || !/^https:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value.includes("@") ||
        url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Invalid configuration: PUBLIC_API_ORIGIN must be an HTTPS origin without credentials, path, query or fragment");
  }
}
