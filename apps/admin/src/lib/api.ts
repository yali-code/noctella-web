const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/** Must match apps/api/src/auth/cookies.ts's SESSION_COOKIE_NAME - no shared package exists
 * between apps/admin and apps/api, so this is duplicated as a literal, matching the existing
 * convention for cross-app constants (e.g. the ERP key header name). */
const SESSION_COOKIE_NAME = "noctella_admin_session";

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

const isServer = typeof window === "undefined";

/**
 * Sprint 64B: the admin app and API are cross-origin (different ports/hosts) in both dev and
 * production. Browser (Client Component) requests need credentials:"include" to send the
 * session cookie - handled directly in request() below. Server Component requests run on the
 * Next.js server, not in the browser, so the browser never attaches anything automatically; the
 * incoming request's session cookie has to be read (via next/headers, only valid in a server
 * context) and forwarded manually. Dynamic import keeps this file safely importable from Client
 * Components too - a static top-level `next/headers` import would break that.
 */
async function serverCookieHeader(): Promise<string | undefined> {
  if (!isServer) return undefined;
  try {
    const { cookies } = await import("next/headers");
    const token = cookies().get(SESSION_COOKIE_NAME)?.value;
    return token ? `${SESSION_COOKIE_NAME}=${token}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Centralized 401 handling for the browser only. A hard navigation (not a client-side router
 * push) is used deliberately: it can't be silently swallowed by a page's own try/catch the way
 * throwing from deep inside this shared helper could be - see the implementation report for why
 * an equivalent automatic redirect is not attempted for Server Component requests.
 */
function redirectToLoginFromBrowser(): void {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const cookieHeader = await serverCookieHeader();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: isServer ? undefined : "include",
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...options?.headers,
    },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    if (res.status === 401 && !isServer) redirectToLoginFromBrowser();
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }),
  put: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};


export async function uploadForm<T>(path: string, formData: FormData): Promise<T> {
  const cookieHeader = await serverCookieHeader();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    body: formData,
    credentials: isServer ? undefined : "include",
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) {
    if (res.status === 401 && !isServer) redirectToLoginFromBrowser();
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  }
  return body as T;
}
