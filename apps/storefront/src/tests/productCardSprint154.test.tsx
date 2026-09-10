// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductCard } from "@/components/ProductCard";
import type { PublicProduct } from "@/lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));

const product: PublicProduct = {
  id: "product-1", slug: "brass-clock", title: "Antique Brass Clock", type: "physical",
  condition: "Very good", categoryName: "Timepieces", priceEur: 125, customsWarning: false, isFeatured: false,
  allowMakeOffer: false, allowCashOnDelivery: false, status: "Published", images: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Sprint 154 ProductCard", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("renders condition, title, price, and a meaningful missing-image state", () => {
    render(<ProductCard product={product} />);
    expect(screen.getByText("Very good")).toBeTruthy();
    expect(screen.getByText("Antique Brass Clock")).toBeTruthy();
    expect(screen.getByText("Timepieces")).toBeTruthy();
    expect(screen.getByText("€125.00")).toBeTruthy();
    expect(screen.getByText("Image unavailable")).toBeTruthy();
  });

  it("omits category when the public product has none", () => {
    render(<ProductCard product={{ ...product, categoryName: undefined }} />);
    expect(screen.queryByText("Timepieces")).toBeNull();
  });

  it("renders malformed runtime prices defensively", () => {
    render(<ProductCard product={{ ...product, priceEur: Number.NaN }} />);
    expect(screen.getByText("Price unavailable")).toBeTruthy();
  });

  it("reflects an existing persisted wishlist entry on initial client render", async () => {
    localStorage.setItem("noctella_wishlist", JSON.stringify([product.id]));
    render(<ProductCard product={product} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /remove antique brass clock from wishlist/i }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("keeps wishlist outside the product link, persists state, and emits the update event", () => {
    const onUpdate = vi.fn();
    window.addEventListener("noctella:wishlist-updated", onUpdate);
    const { container } = render(<ProductCard product={product} />);
    const button = screen.getByRole("button", { name: /add antique brass clock to wishlist/i });
    expect(container.querySelector("a button")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("noctella_wishlist") ?? "[]")).toEqual(["product-1"]);
    expect(onUpdate).toHaveBeenCalledOnce();
    window.removeEventListener("noctella:wishlist-updated", onUpdate);
  });
});
