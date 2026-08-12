// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { api } from "@/lib/api";
import * as stockLib from "@/lib/stock";
import StockPage from "./page";

afterEach(() => vi.restoreAllMocks());

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-9",
    sku: "NOC-000123",
    title: "Canon Camera",
    categoryId: "cat-1",
    status: "draft",
    stockQuantity: 1,
    ...overrides,
  };
}

function mockLoads(items: Record<string, unknown>[] = [product()]) {
  vi.spyOn(stockLib, "listStockProducts").mockResolvedValue({ items: items as any, total: items.length, page: 1, pageSize: 50 });
  vi.spyOn(api, "get").mockResolvedValue({
    items: [{ id: "cat-1", name: "Camera", displayOrder: 0, isActive: true, createdAt: "t", updatedAt: "t" }],
    total: 1,
    page: 1,
    pageSize: 100,
  });
}

describe("Stock page (Sprint 137)", () => {
  it("shows the Category column, resolved via the existing categories client pattern", async () => {
    mockLoads();
    render(<StockPage />);
    await screen.findByText("Canon Camera");
    expect(screen.getByText("Camera")).toBeInTheDocument();
  });

  it("shows Quantity, SKU, and Status columns", async () => {
    mockLoads([product({ stockQuantity: 4, status: "approved" })]);
    render(<StockPage />);
    await screen.findByText("Canon Camera");
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("NOC-000123")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("provides a Print Barcode reprint action linking to the label route for the same Product", async () => {
    mockLoads();
    render(<StockPage />);
    await screen.findByText("Canon Camera");
    expect(screen.getByRole("link", { name: "Print Barcode" })).toHaveAttribute("href", "/products/product-9/label");
  });

  it("Stock timeline access remains available", async () => {
    mockLoads();
    render(<StockPage />);
    await screen.findByText("Canon Camera");
    expect(screen.getByRole("link", { name: "View timeline" })).toHaveAttribute("href", "/stock/product-9");
  });
});
