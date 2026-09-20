import { resolvePublicApiBaseUrl, resolveServiceUrl } from "@noctella/shared";

const API_BASE_URL = resolvePublicApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL, process.env.NODE_ENV);
export const customerGoogleStartUrl = `${API_BASE_URL}/api/customer-auth/google/start`;

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

/** Customer-only requests carry the HttpOnly API cookie; ordinary catalog requests stay anonymous. */
export const customerApi = {
  get: <T>(path: string) => request<T>(path, { credentials: "include" }),
  post: <T>(path: string, data: unknown) => request<T>(path, { method: "POST", credentials: "include", body: JSON.stringify(data) }),
  put: <T>(path: string, data: unknown) => request<T>(path, { method: "PUT", credentials: "include", body: JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) => request<T>(path, { method: "PATCH", credentials: "include", body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE", credentials: "include" }),
};
