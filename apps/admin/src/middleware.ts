import { NextRequest, NextResponse } from "next/server";

/** Must match apps/api/src/auth/cookies.ts's SESSION_COOKIE_NAME. */
const SESSION_COOKIE_NAME = "noctella_admin_session";
const PUBLIC_PATHS = ["/login"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Sprint 64B: fast, cookie-presence-only route-shell protection. This is a UX convenience, not
 * the security boundary - the backend's requireAuth is authoritative and validates the session
 * for real on every API call (see the Server/Client data-fetching path in lib/api.ts). Middleware
 * here only avoids rendering a page shell that's certain to fail immediately; it cannot tell a
 * stale/expired cookie from a valid one without a network round-trip to the API on every
 * navigation, so it deliberately never redirects *away* from /login on cookie presence alone -
 * that requires a real validity check, which the login page performs itself via /api/auth/me.
 * This avoids the login -> home -> 401 -> login loop a blind redirect could otherwise produce.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const hasSessionCookie = req.cookies.has(SESSION_COOKIE_NAME);
  if (hasSessionCookie) return NextResponse.next();

  const loginUrl = new URL("/login", req.url);
  const next = `${pathname}${search}`;
  if (next && next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
