import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { restoreInventoryForReturnInTransactionUseCase } from "../src/application/inventory";
import { completeReturnUseCase } from "../src/use-cases/return/useCases";

const time = "2026-01-01T00:00:00.000Z";

describe("Sprint 35H return Inventory runtime", () => {
  test("PostgreSQL-style Inventory execution remains asynchronous", async () => {
    const repositories: any = {
      products: { update: vi.fn() },
      inventory: { findByProduct: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 1, updatedAt: time }), updateWithVersion: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 2, updatedAt: time }) },
      stockMovements: { findByIdempotencyKey: vi.fn().mockResolvedValue(null), append: vi.fn().mockResolvedValue({ id: "m", productId: "p", type: "return_in", quantityDelta: 1, stockBefore: 1, stockAfter: 2, orderId: "o", orderItemId: "i", note: "Return r", idempotencyKey: "return-in:r:i", createdAt: time, updatedAt: time }) },
    };
    const execution = restoreInventoryForReturnInTransactionUseCase({ clock: { now: () => new Date(time) }, idGenerator: { newId: () => "m" } }, repositories, { productId: "p", quantity: 1, orderId: "o", orderItemId: "i", note: "Return r", idempotencyKey: "return-in:r:i" });
    expect(execution).toBeInstanceOf(Promise);
    await expect(execution).resolves.toMatchObject({ inventory: { quantity: 2 }, replayed: false });
  });

  test("return failure preserves the existing error", async () => {
    const failure = new Error("return completion failed");
    const context: any = { unitOfWork: { run: vi.fn().mockRejectedValue(failure) }, ports: { enqueueStockSync: vi.fn() } };
    await expect(completeReturnUseCase(context, "return")).rejects.toBe(failure);
  });

  test("migrated return path delegates Inventory mutation and contains no direct legacy stock mutation", () => {
    const source = readFileSync(new URL("../src/use-cases/return/useCases.ts", import.meta.url), "utf8");
    const completion = source.slice(source.indexOf("export async function completeReturnUseCase"), source.indexOf("export const cancelReturnUseCase"));
    expect(completion).toContain("restoreInventoryForReturnInTransactionUseCase");
    expect(completion).not.toMatch(/repositories\.stock\.stockMovements|inventoryRepositories\.(inventory|stockMovements)\.(updateWithVersion|append)/);
  });
});
