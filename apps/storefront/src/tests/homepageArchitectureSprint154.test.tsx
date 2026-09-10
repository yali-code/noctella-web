// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HomeClient } from "@/app/HomeClient";
import { api } from "@/lib/api";
import type { PublicProduct } from "@/lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get: vi.fn() } }));

function product(id: string): PublicProduct {
  return { id, slug: id, title: `Object ${id}`, type: "physical", condition: "Good", priceEur: 10,
    customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false,
    status: "Published", images: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("Sprint 154 homepage architecture", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());
  afterEach(cleanup);

  it("uses the product-first hierarchy and bounded marketplace queries", async () => {
    const newest = Array.from({ length: 8 }, (_, index) => product(`new-${index}`));
    const featured = [product("featured-only")];
    const curator = [product("curator-only")];
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      const requestPath = String(path);
      if (requestPath.includes("sort=newest")) return { items: newest, total: newest.length, page: 1, pageSize: 8 } as never;
      if (requestPath.includes("isFeatured=true")) return { items: featured, total: 1, page: 1, pageSize: 8 } as never;
      if (requestPath.includes("collectionSlug=curators-pick")) return { items: curator, total: 2, page: 1, pageSize: 8 } as never;
      return { items: [{ id: "cat", name: "Lighting", slug: "lighting" }] } as never;
    });
    const { container } = render(<HomeClient />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const headings = [...container.querySelectorAll("h2")].map((node) => node.textContent);
    expect(headings).toEqual(["Categories", "New Arrivals", "Featured Objects", "Curator's Pick", "Every Object Has a Story"]);
    expect(screen.getByRole("link", { name: "Lighting" }).getAttribute("href")).toBe("/category/lighting");
    expect(container.textContent).not.toContain("Archive / Sold Gallery");
    expect(container.textContent).not.toContain("Newsletter");
    expect(container.textContent).not.toContain("Gentleman Series");
    const arrivalsSection = screen.getByRole("heading", { name: "New Arrivals" }).closest("section")!;
    expect(within(arrivalsSection).getAllByRole("heading", { level: 3 }).map((node) => node.textContent))
      .toEqual(newest.slice(0, 8).map((item) => item.title));
    expect(screen.queryByRole("heading", { name: "Explore the Collection" })).toBeNull();
    expect(screen.getByText("Cash on Delivery")).toBeTruthy();
    expect(screen.getByText("Options and charges are shown at checkout.")).toBeTruthy();
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => String(path).includes("sort=newest"))).toHaveLength(1);
    expect(vi.mocked(api.get).mock.calls.some(([path]) => String(path).includes("collectionSlug=curators-pick"))).toBe(true);
  });

  it("hides an empty Curator's Pick section", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("categories")
      ? { items: [] } as never
      : { items: [], total: 0, page: 1, pageSize: 8 } as never);
    render(<HomeClient />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(screen.queryByRole("heading", { name: "Curator's Pick" })).toBeNull();
  });

  it("isolates an optional Curator's Pick request failure", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      const requestPath = String(path);
      if (requestPath.includes("collectionSlug=curators-pick")) throw new Error("optional collection unavailable");
      if (requestPath.includes("sort=newest")) return { items: [product("newest")], total: 1, page: 1, pageSize: 8 } as never;
      if (requestPath.includes("isFeatured=true")) return { items: [product("featured")], total: 1, page: 1, pageSize: 8 } as never;
      return { items: [{ id: "cat", name: "Lighting", slug: "lighting" }] } as never;
    });
    render(<HomeClient />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(screen.getByRole("link", { name: "Lighting" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Featured Objects" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New Arrivals" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Curator's Pick" })).toBeNull();
  });

  it("shows the primary error while isolating category and merchandising failures", async () => {
    vi.mocked(api.get).mockImplementation(async (requestPath: string) => {
      if (String(requestPath).includes("sort=newest")) throw new Error("unavailable");
      if (String(requestPath).includes("categories")) return { items: [] } as never;
      return { items: [], total: 0, page: 1, pageSize: 8 } as never;
    });
    render(<HomeClient />);
    expect((await screen.findByRole("alert")).textContent).toContain("New arrivals could not be loaded");
    expect(screen.getByRole("heading", { name: "New Arrivals" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All categories" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Featured Objects" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Curator's Pick" })).toBeNull();
  });

  it("defines Product-first Minimal as the layout default and keeps a token-only comparison variant", async () => {
    const css = (await readFile(path.resolve(process.cwd(), "src/app/globals.css"), "utf8")).replace(/\r\n?/g, "\n");
    const layout = await readFile(path.resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('data-storefront-theme="product-first"');
    expect(css).toContain('[data-storefront-theme="noctella-character"]');
    expect(css).toContain("body {\n  margin: 0;\n  padding: 0;\n  background: var(--noctella-night-navy);\n  color: var(--noctella-ivory)");
    expect(css).toContain("background: var(--noctella-deep-star-blue);\n  border: 1px solid var(--noctella-antique-gold)");
    expect(css).toContain("outline: 2px solid var(--noctella-bright-star-gold)");
    expect(css).toContain(".sf-home a:focus-visible,");
    expect(css).toContain("outline-color: var(--sf-focus)");
    expect(css).toContain(".sf-header { position: relative; z-index: 20; background: var(--sf-surface); color: var(--sf-text-primary);");
    expect(css).toContain(".sf-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 32px clamp(16px, 4vw, 40px); border-top: 1px solid var(--sf-border); background: var(--sf-surface); color: var(--sf-text-primary);");
    expect(css).toContain(".sf-home { max-width: 1280px; margin: 0 auto; background: var(--sf-background)");
    expect(css).toContain(".sf-home h1, .sf-home h2, .sf-home h3 { color: var(--sf-text-primary)");
    expect(css).toContain(".sf-product-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }");
    expect(css).toContain("@media (max-width: 339px) { .sf-product-grid { grid-template-columns: 1fr; } }");
    expect(css).toContain("@media (min-width: 640px) { .sf-product-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }");
    expect(css).toContain("@media (min-width: 960px) { .sf-product-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; } }");
  });
});
