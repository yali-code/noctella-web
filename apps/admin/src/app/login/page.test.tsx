// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as authLib from "@/lib/auth";
import { ApiError } from "@/lib/api";
import LoginPage from "./page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const identity = { id: "1", email: "a@b.com", role: "owner", status: "active" };

afterEach(() => vi.restoreAllMocks());

describe("Login page (Sprint 64B)", () => {
  it("renders the login form when not already authenticated, with no registration or reset links", async () => {
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    render(<LoginPage />);
    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    expect(screen.queryByText(/register/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reset/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/forgot/i)).not.toBeInTheDocument();
  });

  it("redirects away immediately (without showing the form) if already authenticated", async () => {
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(identity);
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByPlaceholderText("Email")).not.toBeInTheDocument();
  });

  it("shows the backend's generic error on invalid credentials", async () => {
    const user = userEvent.setup();
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    vi.spyOn(authLib, "login").mockRejectedValue(new ApiError("Invalid email or password", 401));
    render(<LoginPage />);
    await user.type(await screen.findByPlaceholderText("Email"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "wrong");
    await user.click(screen.getByText("Sign in"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("prevents duplicate submission while a login request is in flight", async () => {
    const user = userEvent.setup();
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    let resolveLogin!: (v: authLib.AdminIdentity) => void;
    const loginSpy = vi.spyOn(authLib, "login").mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    render(<LoginPage />);
    await user.type(await screen.findByPlaceholderText("Email"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "pw");
    await user.click(screen.getByText("Sign in"));
    expect(screen.getByText("Signing in…")).toBeDisabled();
    await user.click(screen.getByText("Signing in…"));
    expect(loginSpy).toHaveBeenCalledTimes(1);
    resolveLogin(identity);
  });

  it("redirects to a safe relative ?next= path after successful login", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "location", { value: { search: "?next=%2Fcustomers" }, writable: true });
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    vi.spyOn(authLib, "login").mockResolvedValue(identity);
    render(<LoginPage />);
    await user.type(await screen.findByPlaceholderText("Email"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "pw");
    await user.click(screen.getByText("Sign in"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/customers"));
  });

  it("ignores an unsafe/external next target and redirects to / instead", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "location", { value: { search: "?next=https://evil.example.com" }, writable: true });
    vi.spyOn(authLib, "getCurrentAdmin").mockResolvedValue(null);
    vi.spyOn(authLib, "login").mockResolvedValue(identity);
    render(<LoginPage />);
    await user.type(await screen.findByPlaceholderText("Email"), "a@b.com");
    await user.type(screen.getByPlaceholderText("Password"), "pw");
    await user.click(screen.getByText("Sign in"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});
