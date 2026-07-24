// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as authLib from "@/lib/auth";
import { LogoutControl } from "./LogoutControl";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const identity = { id: "1", email: "owner@example.com", role: "owner", status: "active" };

afterEach(() => vi.restoreAllMocks());

describe("LogoutControl (Sprint 64B)", () => {
  it("renders nothing when there is no valid session (e.g. on /login itself)", async () => {
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    const { container } = render(<LogoutControl />);
    await waitFor(() => expect(authLib.getCurrentAdmin).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current admin's email and role plus a sign-out control when authenticated", async () => {
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(identity);
    render(<LogoutControl />);
    expect(await screen.findByText(/owner@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/owner/)).toBeInTheDocument();
    expect(screen.getByText("Sign out")).toBeInTheDocument();
  });

  it("calls logout and redirects to /login on click", async () => {
    const user = userEvent.setup();
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(identity);
    const logoutSpy = vi.spyOn(authLib, "logout").mockResolvedValue(undefined);
    render(<LogoutControl />);
    await user.click(await screen.findByText("Sign out"));
    expect(logoutSpy).toHaveBeenCalled();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("prevents duplicate submission while signing out", async () => {
    const user = userEvent.setup();
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(identity);
    let resolveLogout!: () => void;
    const logoutSpy = vi.spyOn(authLib, "logout").mockReturnValue(new Promise((resolve) => { resolveLogout = resolve; }));
    render(<LogoutControl />);
    await user.click(await screen.findByText("Sign out"));
    expect(screen.getByText("Signing out…")).toBeDisabled();
    await user.click(screen.getByText("Signing out…"));
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    resolveLogout();
  });

  it("still redirects to /login even if the logout call fails (already-expired session)", async () => {
    const user = userEvent.setup();
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(identity);
    vi.spyOn(authLib, "logout").mockRejectedValue(new Error("session already gone"));
    render(<LogoutControl />);
    await user.click(await screen.findByText("Sign out"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });
});
