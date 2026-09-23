// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  vi.spyOn(stockLib, "listStockMovements").mockResolvedValue({ items: items.map((p) => ({ id: `m-${p.id}`, productId: p.id, createdAt: new Date().toISOString(), type: "manual_adjustment", idempotencyKey: `product-create-stock:${p.id}`, quantityDelta: p.stockQuantity, stockBefore: 1, stockAfter: p.stockQuantity })) as any, total: items.length, page: 1, pageSize: 100 });
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
    expect(within(screen.getByRole("table")).getByText("4")).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Timeline" })).toHaveAttribute("href", "/stock/product-9");
    expect(screen.getByRole("link", { name: "Card" })).toHaveAttribute("href", "/stock/product-9/card");
  });

  it("shows overview totals and lets All include products with no opening movement", async () => {
    const user = userEvent.setup();
    mockLoads([product({ stockQuantity: 3, purchaseCost: 10 })]);
    vi.mocked(stockLib.listStockMovements).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    render(<StockPage />);
    expect(await screen.findByRole("region", { name: "Stock Products" })).toHaveTextContent("1");
    expect(screen.getByRole("region", { name: "Units in Stock" })).toHaveTextContent("3");
    expect(screen.getByRole("region", { name: "Received This Month" })).toHaveTextContent("0");
    expect(screen.getByRole("region", { name: "Recorded Stock Cost" })).toHaveTextContent("€30.00");
    expect(screen.queryByText("Canon Camera")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Canon Camera")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("—")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Custom Range" }));
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("Through")).toBeInTheDocument();
  });
});
