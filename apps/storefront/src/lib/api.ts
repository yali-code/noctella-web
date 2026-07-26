import { resolveServiceUrl } from "@noctella/shared";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/**
 * Sprint 70: the API returns product-photo URLs as portable relative paths (e.g.
 * "/images/product-photos/example.webp"), never baking in a specific origin. Every `<img>` in
 * the Storefront must resolve that path against the configured API origin at render time - this
 * is the single central resolver, so no component re-implements URL concatenation. Absolute URLs
 * (external marketplace images, data:/blob: URIs) pass through unchanged. The cart/checkout
 * draft data itself must keep storing the original relative value - only render call sites
 * resolve it.
 */
export function resolveApiAssetUrl(value?: string | null): string {
  return resolveServiceUrl(value, API_BASE_URL);
}

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  details?: ApiErrorDetail[];
  status: number;

  constructor(message: string, status: number, details?: ApiErrorDetail[]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }),
};
