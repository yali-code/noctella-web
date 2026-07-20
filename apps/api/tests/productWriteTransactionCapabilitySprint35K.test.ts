import { describe, expect, test, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createProductWriteRepositoryBundleForDb } from "../src/repositories/product-write/factory";
import { assertProductWriteTransactionCapabilityForDriver, createProductWriteTransactionCapabilityForDb } from "../src/services/productWriteTransactionCapabilityForDb";

const values = (id: string, sku: string) => ({ id, sku, title: sku, slug: sku.toLowerCase(), type: ProductType.UniqueItem, status: ProductStatus.Draft, stockQuantity: 1, priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

describe("Sprint 35K Product Write transaction capability", () => {
  test("SQLite callback and repository execution are genuinely synchronous", () => {
    const capability = createProductWriteTransactionCapabilityForDb(createTestDb(), "sqlite");
    const result = capability.run(({ repositories }) => {
      const created = repositories.productWriteRepositories.products.create({ values: values("p1", "SKU1") });
      expect(created).not.toBeInstanceOf(Promise);
      return created.id;
    });
    expect(result).toBe("p1");
  });

  test("SQLite rejects an asynchronous transaction callback", () => {
    const capability = createProductWriteTransactionCapabilityForDb(createTestDb(), "sqlite");
    expect(() => (capability as any).run(async () => "invalid")).toThrow("SQLITE_ASYNC_PRODUCT_WRITE_TRANSACTION_CALLBACK_REJECTED");
  });

  test("SQLite commit persists Product Write changes", async () => {
    const db = createTestDb();
    createProductWriteTransactionCapabilityForDb(db, "sqlite").run(({ repositories }) => repositories.productWriteRepositories.products.create({ values: values("p1", "SKU1") }));
    expect(await createProductWriteRepositoryBundleForDb(db, "sqlite").products.existsBySku("SKU1")).toBe(true);
  });

  test("SQLite failure rolls back every Product Write change", async () => {
    const db = createTestDb();
    expect(() => createProductWriteTransactionCapabilityForDb(db, "sqlite").run(({ repositories }) => {
      repositories.productWriteRepositories.products.create({ values: values("p1", "SKU1") });
      repositories.productWriteRepositories.products.create({ values: values("p2", "SKU2") });
      throw new Error("rollback");
    })).toThrow("rollback");
    const repository = createProductWriteRepositoryBundleForDb(db, "sqlite").products;
    expect(await repository.existsBySku("SKU1")).toBe(false);
    expect(await repository.existsBySku("SKU2")).toBe(false);
  });

  test("PostgreSQL capability preserves asynchronous execution", async () => {
    const db = { transaction: vi.fn(async (work) => work({})) } as any;
    const capability = createProductWriteTransactionCapabilityForDb(db, "postgres");
    const result = capability.run(async () => "ok");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe("ok");
  });

  test("driver and execution capability mismatches are rejected", () => {
    expect(() => assertProductWriteTransactionCapabilityForDriver("sqlite", { driver: "postgres", execution: "asynchronous", run: vi.fn() } as any)).toThrow("PRODUCT_WRITE_TRANSACTION_DRIVER_MISMATCH:sqlite:postgres");
    expect(() => assertProductWriteTransactionCapabilityForDriver("sqlite", { driver: "sqlite", execution: "asynchronous", run: vi.fn() } as any)).toThrow("PRODUCT_WRITE_TRANSACTION_EXECUTION_MISMATCH:sqlite:synchronous:asynchronous");
  });

  test("public Product Write repository contract remains asynchronous", async () => {
    const result = createProductWriteRepositoryBundleForDb(createTestDb(), "sqlite").products.create({ values: values("p1", "SKU1") });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ id: "p1" });
  });
});
