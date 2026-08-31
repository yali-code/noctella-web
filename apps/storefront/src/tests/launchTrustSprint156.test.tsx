// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountPage from "@/app/account/page";
import ContactPage from "@/app/contact/page";
import ReturnsPolicyPage from "@/app/returns-policy/page";
import ShippingDeliveryPage from "@/app/shipping-delivery/page";
import { Header } from "@/components/Header";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

describe("Sprint 156 launch-safe header", () => {
  it("removes Account from desktop and mobile while preserving customer navigation and keyboard behavior", () => {
    render(<Header />);
    const desktop = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(desktop).queryByRole("link", { name: "Account" })).toBeNull();
    expect(within(desktop).getByRole("link", { name: /Wishlist/ })).toBeTruthy();
    expect(within(desktop).getByRole("link", { name: /Cart/ })).toBeTruthy();
    expect(within(desktop).getByRole("searchbox")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "Toggle navigation menu" });
    fireEvent.click(trigger);
    const mobile = screen.getByRole("navigation", { name: "Mobile navigation" });
    expect(within(mobile).queryByRole("link", { name: "Account" })).toBeNull();
    expect(within(mobile).getByRole("link", { name: /Wishlist/ })).toBeTruthy();
    expect(within(mobile).getByRole("link", { name: /Cart/ })).toBeTruthy();
    expect(within(mobile).getByRole("searchbox")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Sprint 156 customer trust routes", () => {
  it("presents /account as guest-commerce help without account-system affordances", () => {
    const { container } = render(<AccountPage />);
    expect(screen.getByRole("heading", { name: "Customer Account" })).toBeTruthy();
    expect(screen.getByText(/guest checkout/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Customer Support at support@noctella.com/i }).getAttribute("href")).toBe("/contact");
    expect(screen.getByRole("link", { name: "Browse the shop" }).getAttribute("href")).toBe("/shop");
    expect(container.textContent).not.toMatch(/placeholder|sprint 1/i);
    expect(container.textContent).not.toMatch(/log[ -]?in|register/i);
  });

  it("provides an actionable support channel without an unfinished form promise", () => {
    const { container } = render(<ContactPage />);
    expect(screen.getByRole("heading", { name: "Contact Noctella" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "support@noctella.com" }).getAttribute("href")).toBe("mailto:support@noctella.com");
    expect(screen.getByText(/within two business days/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/published here soon|message form will/i);
  });

  it("publishes complete delivery guidance and preserves statutory rights", () => {
    const { container } = render(<ShippingDeliveryPage />);
    expect(screen.getByText(/1–3 business days/i)).toBeTruthy();
    expect(screen.getByText(/shown during checkout based on the destination/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Customs, Duties & Import Taxes" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Delivery Problems" })).toBeTruthy();
    expect(screen.getByText(/Nothing on this page limits any mandatory consumer rights/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Customs & Import Duties" }).getAttribute("href")).toBe("/customs-duties");
    expect(container.textContent).not.toMatch(/complete shipping terms|ordering process is finalized/i);
  });

  it("publishes the approved return model without prohibited exclusions", () => {
    const { container } = render(<ReturnsPolicyPage />);
    expect(screen.getByText(/request a return within 30 calendar days/i)).toBeTruthy();
    expect(screen.getByText(/responsible for arranging and paying the return shipping/i)).toBeTruthy();
    expect(screen.getByText(/arrange or reimburse a reasonable return method/i)).toBeTruthy();
    expect(screen.getByText(/tracked return service/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vintage & Pre-Owned Condition" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your Statutory Rights" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/case-by-case|finalized|all sales final|no warranty/i);
  });
});
