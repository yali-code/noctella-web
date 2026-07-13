import { describe, expect, it, vi } from "vitest";
import { createStockAdjustment, listStockMovements, listStockProducts } from "./stock";

vi.mock("./api", () => ({
  api: {
    get: vi.fn((path: string) => Promise.resolve({ path, items: [], total: 0, page: 1, pageSize: 50 })),
    post: vi.fn((path: string, data: unknown) => Promise.resolve({ path, data })),
  },
}));

describe("stock admin client", () => {
  it("lists stock products through the product catalog endpoint", async () => {
    await expect(listStockProducts(2, 25)).resolves.toMatchObject({ path: "/api/products?page=2&pageSize=25" });
  });

  it("filters stock movement timelines by product", async () => {
    await expect(listStockMovements("product-1")).resolves.toMatchObject({
      path: "/api/stock-movements?pageSize=100&productId=product-1",
    });
  });

  it("posts manual adjustments", async () => {
    await expect(createStockAdjustment({ productId: "product-1", quantityDelta: 2 })).resolves.toMatchObject({
      path: "/api/stock-movements/adjustments",
      data: { productId: "product-1", quantityDelta: 2 },
    });
  });
});
