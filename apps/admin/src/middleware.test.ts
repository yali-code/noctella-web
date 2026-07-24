import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function makeRequest(path: string, cookieValue?: string) {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `noctella_admin_session=${cookieValue}`);
  return new NextRequest(new URL(`http://localhost:3001${path}`), { headers });
}

describe("admin middleware (Sprint 64B)", () => {
  it("lets /login through even without a session cookie", () => {
    const res = middleware(makeRequest("/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a protected route to /login when no session cookie is present", () => {
    const res = middleware(makeRequest("/customers"));
    const location = res.headers.get("location");
    expect(location).toContain("/login");
  });

  it("preserves the original path as a ?next= redirect target", () => {
    const res = middleware(makeRequest("/customers/c1"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("next")).toBe("/customers/c1");
  });

  it("does not append a next param for the root path", () => {
    const res = middleware(makeRequest("/"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("next")).toBeNull();
  });

  it("passes a protected route through when a session cookie is present (validity is checked server-side, not here)", () => {
    const res = middleware(makeRequest("/customers", "some-token-value"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("never redirects away from /login just because a cookie is present (avoids a blind-redirect loop)", () => {
    const res = middleware(makeRequest("/login", "possibly-stale-token"));
    expect(res.headers.get("location")).toBeNull();
  });
});
