// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { api } from "@/lib/api";
import { purchasingApi } from "@/lib/erpPurchasingBridge";
import * as stock from "@/lib/stockDashboard";
import * as inventory from "@/lib/erpInventoryBridge";
import StockCardPage from "./page";

afterEach(() => vi.restoreAllMocks());
const openingDate = "2026-09-01T10:00:00.000Z";
function loads(items: any[] = [], purchaseCost?: number) {
  vi.spyOn(inventory, "getOperationalAcquisition").mockResolvedValue({});
  vi.spyOn(api, "get").mockImplementation(async (path) => path.startsWith("/api/categories/") ? { id: "cat", name: "Collectibles" } as any : {
    id: "p", title: "Antique Clock", sku: "NOC-000009", categoryId: "cat", type: "unique", status: "draft", stockQuantity: 1, purchaseCost,
    createdAt: "2020-01-01", updatedAt: "2026-09-20", photos: [{ id: "photo", isPrimary: true, url: "/images/clock.webp", altText: "Clock photo" }], images: [], marketplaceReadiness: {},
  } as any);
  vi.spyOn(stock, "allStockMovements").mockResolvedValue([
    { id: "opening", productId: "p", idempotencyKey: "product-create-stock:p", type: "manual_adjustment", stockBefore: 1, quantityDelta: 1, stockAfter: 1, createdAt: openingDate },
    { id: "later", productId: "p", type: "manual_adjustment", quantityDelta: 1, stockBefore: 0, stockAfter: 1, createdAt: "2026-09-02T10:00:00.000Z" },
  ] as any);
  vi.spyOn(purchasingApi, "productPurchaseHistory").mockResolvedValue({ productId: "p", items });
}
function purchase(id: string, supplier: string) {
  return { purchase: { id, sourceType: "Auction", auctionHouse: `House ${id}` }, supplier: { name: supplier }, purchaseLine: { id: `line-${id}`, unitPurchaseCost: 12 },
    landedCost: { landedUnitCost: 15, landedTotalCost: 30 }, receiptStatus: "Received", sourceReferences: { externalReference: `EXT-${id}`, invoiceReferenceNumber: `INV-${id}`, erpReferenceId: `ERP-${id}` },
    dates: { orderedAt: "2026-08-01T10:00:00.000Z", receivedAt: "2026-09-01T10:00:00.000Z" } };
}
describe("read-only Stock Card", () => {
  it("shows operational acquisition for confirmed empty formal history without inventing dates", async () => {
    loads([], 25);
    vi.mocked(inventory.getOperationalAcquisition).mockResolvedValue({ purchaseSource: "Kleinanzeigen", auctionHouse: "Example Auction", invoiceReferenceNumber: "REF-123", provenance: "Private collection", previousOwner: "Estate seller" });
    render(<StockCardPage params={{ productId: "p" }} />);
    await screen.findByText("Kleinanzeigen");
    expect(screen.getByText("Intake / Operational Acquisition")).toBeInTheDocument();
    const acquisition = screen.getByRole("region", { name: "Acquisition" });
    for (const value of ["Example Auction", "REF-123", "Private collection", "Estate seller"]) expect(within(acquisition).getByText(value)).toBeInTheDocument();
    expect(acquisition).toHaveTextContent("25.00");
    expect(acquisition).not.toHaveTextContent(/2020|2026|Ordered date|Received date/);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(inventory.getOperationalAcquisition).toHaveBeenCalledExactlyOnceWith("p");
  });
  it("distinguishes failed operational data from missing values", async () => {
    loads();
    vi.mocked(inventory.getOperationalAcquisition).mockRejectedValue(new Error("unavailable"));
    render(<StockCardPage params={{ productId: "p" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Operational acquisition could not be loaded");
    expect(screen.queryByText("Purchase source")).not.toBeInTheDocument();
  });
  it("shows identity, primary photo, actual opening date and quantity with the existing action destinations", async () => {
    loads();
    render(<StockCardPage params={{ productId: "p" }} />);
    expect(await screen.findByRole("heading", { name: "Stock Card · Antique Clock" })).toBeInTheDocument();
    const identity = screen.getByRole("region", { name: "Product identity" });
    for (const value of ["NOC-000009", "Collectibles", "unique", "draft", "1"]) expect(within(identity).getByText(value)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Clock photo" })).toHaveAttribute("src", expect.stringContaining("/images/clock.webp"));
    const history = screen.getByRole("region", { name: "Stock history" });
    expect(within(history).getByText(new Date(openingDate).toLocaleString())).toBeInTheDocument();
    expect(within(history).getByText(new Date("2026-09-02T10:00:00.000Z").toLocaleString())).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Timeline" })).toHaveAttribute("href", "/stock/p");
    expect(screen.getByRole("link", { name: "Print Barcode" })).toHaveAttribute("href", "/products/p/label");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(stock.allStockMovements).toHaveBeenCalledWith("p");
    expect(purchasingApi.productPurchaseHistory).toHaveBeenCalledExactlyOnceWith("p");
  });
  it("shows each real acquisition separately, including recorded costs, sources, references and dates", async () => {
    loads([purchase("a", "Supplier Alpha"), purchase("b", "Supplier Beta")], 15);
    vi.mocked(inventory.getOperationalAcquisition).mockResolvedValue({ purchaseSource: "Conflicting intake source", auctionHouse: "Conflicting house" });
    render(<StockCardPage params={{ productId: "p" }} />);
    await screen.findByText("Supplier Alpha");
    expect(screen.getByText("Product purchase cost (per unit): €15.00")).toBeInTheDocument();
    const entries = screen.getAllByRole("article");
    expect(entries).toHaveLength(2);
    expect(inventory.getOperationalAcquisition).not.toHaveBeenCalled();
    expect(screen.queryByText("Intake / Operational Acquisition")).not.toBeInTheDocument();
    expect(screen.queryByText("Conflicting intake source")).not.toBeInTheDocument();
    for (const [index, id] of ["a", "b"].entries()) {
      const entry = within(entries[index]);
      for (const value of ["Auction", `House ${id}`, `EXT-${id}`, `INV-${id}`, `ERP-${id}`, "€12.00", "€15.00", "€30.00", "Received", new Date("2026-08-01T10:00:00.000Z").toLocaleString(), new Date(openingDate).toLocaleString()]) {
        expect(entry.getByText(value)).toBeInTheDocument();
      }
    }
  });
  it("shows Not recorded for intake-only acquisition data without inventing a cost or purchase date", async () => {
    loads();
    render(<StockCardPage params={{ productId: "p" }} />);
    const acquisition = await screen.findByRole("region", { name: "Acquisition" });
    expect(within(acquisition).getByText("Product purchase cost (per unit): Not recorded")).toBeInTheDocument();
    expect(await within(acquisition).findAllByText("Not recorded")).toHaveLength(5);
    expect(acquisition).not.toHaveTextContent("€0");
    expect(acquisition).not.toHaveTextContent("2020");
  });
  it("distinguishes unavailable purchase history from a confirmed empty history", async () => {
    loads();
    vi.mocked(purchasingApi.productPurchaseHistory).mockRejectedValue(new Error("unavailable"));
    render(<StockCardPage params={{ productId: "p" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Purchase history could not be loaded");
    expect(screen.queryByText("Purchase source")).not.toBeInTheDocument();
    expect(inventory.getOperationalAcquisition).not.toHaveBeenCalled();
  });
});
