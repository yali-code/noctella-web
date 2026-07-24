// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as authLib from "@/lib/auth";
import { AdminShell } from "./AdminShell";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ replace: vi.fn() }) }));

afterEach(() => {
  vi.restoreAllMocks();
  pathname = "/";
});

describe("AdminShell (Sprint 67)", () => {
  it("renders only the page content on /login - no sidebar, menu, or logout control", () => {
    pathname = "/login";
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    render(
      <AdminShell>
        <div>Login form</div>
      </AdminShell>,
    );
    expect(screen.getByText("Login form")).toBeInTheDocument();
    expect(screen.queryByText("Noctella")).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
  });

  it("renders the sidebar, menu, logout control, and page content on an authenticated Admin route", async () => {
    pathname = "/products";
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue({ id: "1", email: "owner@example.com", role: "owner", status: "active" });
    render(
      <AdminShell>
        <div>Products page</div>
      </AdminShell>,
    );
    expect(screen.getByText("Noctella")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Products page")).toBeInTheDocument();
    expect(await screen.findByText("Sign out")).toBeInTheDocument();
  });
});
