// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import CartPage from "@/app/cart/page";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock("@/components/CartFreshness", () => ({
  useCartFreshness: () => ({
    items: [{ productId: "p1", slug: "clock", title: "Brass Clock", primaryImageUrl: undefined, eurPrice: 25, quantity: 1, productType: "unique_item", allowCashOnDelivery: true }],
    loading: false, error: false, result: null, canProceed: true, reconcileNow: vi.fn(), acceptChanges: vi.fn(), removeUnavailable: vi.fn(), retry: vi.fn(),
  }),
  CartFreshnessBlocker: () => null,
}));

describe("Sprint 167 responsive cart presentation", () => {
  afterEach(cleanup);

  it("keeps one semantic item collection and one remove action while CSS adapts it for mobile", async () => {
    const { container } = render(<CartPage />);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Brass Clock" })).toBeTruthy();
    const css = await readFile(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".sf-cart-table tbody tr { display: grid;");
    expect(css).toContain("content: attr(data-label)");
  });
});
