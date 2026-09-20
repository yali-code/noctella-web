// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountClient from "../app/account/AccountClient";
import { ApiError, customerApi } from "../lib/api";

vi.mock("next/link", () => ({ default: ({ href, children }: React.PropsWithChildren<{ href: string }>) => <a href={href}>{children}</a> }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), customerApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

describe("Packet J account experience", () => {
  beforeEach(() => { window.history.replaceState(null, "", "/account"); vi.mocked(customerApi.get).mockReset(); vi.mocked(customerApi.post).mockReset(); });
  afterEach(() => cleanup());

  it("keeps guest checkout visible and supports registration without marketing opt-in", async () => {
    vi.mocked(customerApi.get).mockRejectedValue(new ApiError("Authentication required", 401));
    vi.mocked(customerApi.post).mockResolvedValue({ ok: true });
    render(<AccountClient />);
    expect(screen.getByText("Guest checkout")).toBeTruthy();
    fireEvent.click(screen.getByRole("navigation", { name: "Account options" }).querySelectorAll("button")[1]);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Buyer Example" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "buyer@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "strong-pass-123" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("heading", { name: "Create account" }).closest("form")!);
    await waitFor(() => expect(customerApi.post).toHaveBeenCalledWith("/api/customer-auth/register", { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer Example", termsAccepted: true }));
    expect(await screen.findByText(/Check your email to verify/)).toBeTruthy();
  });

  it("renders only the current Customer's profile, addresses and linked orders", async () => {
    vi.mocked(customerApi.get).mockImplementation(async (path) => {
      if (path.endsWith("/profile")) return { email: "buyer@example.test", name: "Buyer", phone: null } as never;
      if (path.endsWith("/addresses")) return { items: [{ id: "a", type: "Shipping", fullName: "Buyer", line1: "Street", city: "City", postalCode: "10000", country: "Germany", countryCode: "DE" }] } as never;
      return { items: [{ id: "order", orderNumber: "N-1", status: "Pending", totalAmount: 12, currency: "EUR", createdAt: "2026-01-01" }] } as never;
    });
    render(<AccountClient />);
    expect(await screen.findByText(/Signed in as buyer@example.test/)).toBeTruthy();
    expect(screen.getByText(/Shipping: Buyer, Street/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /N-1/ })).toBeTruthy();
  });
});
