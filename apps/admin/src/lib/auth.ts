import { api, ApiError } from "./api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export interface AdminIdentity {
  id: string;
  email: string;
  role: string;
  status: string;
}

/**
 * Deliberately bypasses the shared api.ts request() helper: a failed login attempt returning
 * 401 is a normal, expected outcome here (shown inline on the login form), not a signal that an
 * existing session died - api.ts's centralized 401 handler would otherwise hard-navigate back
 * to /login mid-attempt, wiping out the inline error the login page is trying to show.
 */
export async function login(email: string, password: string): Promise<AdminIdentity> {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  }
  return body as AdminIdentity;
}

export async function logout(): Promise<void> {
  await api.post<{ ok: boolean }>("/api/auth/logout", {});
}

/**
 * Deliberately bypasses the shared api.ts request() helper, for the same reason as login()
 * above: an unauthenticated /me response is a normal, expected outcome wherever session state is
 * being checked - including on the login page itself, where api.ts's centralized 401 handler
 * hard-navigating back to /login would re-trigger this same check and loop forever.
 */
export async function getCurrentAdmin(): Promise<AdminIdentity | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: "include" });
    if (res.status === 401) return null;
    const isJson = res.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await res.json() : undefined;
    if (!res.ok) return null;
    return body as AdminIdentity;
  } catch {
    return null;
  }
}

/** Only a relative, same-app path is ever honored as a post-login redirect target. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("://")) return "/";
  return next;
}
