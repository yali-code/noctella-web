import { StockMovementType } from "@noctella/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  createManualStockAdjustment,
  filterProductsByStockState,
  latestMovementForProduct,
  listStockProducts,
  paginateStockItems,
  sortMovementsChronologically,
  type ProductListItem,
  type StockMovement,
} from "./stock";

function mockFetchOnce(status: number, body: unknown, ok: boolean) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  }) as unknown as typeof fetch;
}

const products = [
  { id: "p1", title: "Lamp", sku: "LAMP-1", stockQuantity: 2 },
  { id: "p2", title: "Chair", sku: "CHAIR-1", stockQuantity: 0 },
] as ProductListItem[];

const movements = [
  { id: "m1", createdAt: "2026-01-01T00:00:00.000Z", type: StockMovementType.Purchase, quantity: 2 },
  { id: "m2", createdAt: "2026-01-02T00:00:00.000Z", type: StockMovementType.ManualDecrease, quantity: 1 },
] as StockMovement[];

describe("admin stock helpers", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("maps stock list latest movement data", () => {
    expect(latestMovementForProduct(movements)).toMatchObject({ id: "m2", quantity: 1 });
  });

  it("sends search to the products API", async () => {
    mockFetchOnce(200, { items: products, total: 2, page: 1, pageSize: 100 }, true);

    await listStockProducts("Lamp");

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("search=Lamp");
  });

  it("filters in-stock and out-of-stock products", () => {
    expect(filterProductsByStockState(products, "in_stock").map((product) => product.id)).toEqual(["p1"]);
    expect(filterProductsByStockState(products, "out_of_stock").map((product) => product.id)).toEqual(["p2"]);
  });

  it("paginates stock items", () => {
    const result = paginateStockItems([1, 2, 3], 2, 2);
    expect(result.items).toEqual([3]);
    expect(result.totalPages).toBe(2);
  });

  it("sorts product history newest first for timeline ordering", () => {
    expect(sortMovementsChronologically(movements).map((movement) => movement.id)).toEqual(["m2", "m1"]);
  });

  it("creates manual increase, decrease, and correction payloads", async () => {
    mockFetchOnce(201, { id: "m1" }, true);
    await createManualStockAdjustment({ productId: "p1", type: StockMovementType.ManualIncrease, quantity: 2 });
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)).toMatchObject({
      productId: "p1",
      type: StockMovementType.ManualIncrease,
      quantity: 2,
    });

    mockFetchOnce(201, { id: "m2" }, true);
    await createManualStockAdjustment({ productId: "p1", type: StockMovementType.ManualDecrease, quantity: 1 });
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)).toMatchObject({
      type: StockMovementType.ManualDecrease,
      quantity: 1,
    });

    mockFetchOnce(201, { id: "m3" }, true);
    await createManualStockAdjustment({ productId: "p1", type: StockMovementType.Correction, quantity: 7 });
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)).toMatchObject({
      type: StockMovementType.Correction,
      quantity: 7,
      newStock: 7,
    });
  });

  it("rejects invalid adjustments without a successful stock change", async () => {
    mockFetchOnce(400, { error: "Stock cannot become negative" }, false);

    await expect(
      createManualStockAdjustment({ productId: "p1", type: StockMovementType.ManualDecrease, quantity: 99 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
