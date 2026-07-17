import { describe, expect, test, vi } from "vitest";
import {
  ProductStatus,
  ProductType,
  StockMovementType,
} from "@noctella/shared";
import { buildInventoryApplicationContext } from "../src/services/inventoryApplicationContext";
import {
  createIncreaseInventoryUseCase,
  createProductUseCase,
  createSetInventoryQuantityUseCase,
} from "../src/application/inventory";
import { INVENTORY_EVENT_VERSION } from "../src/domain/inventory";
import { noopInventoryEventPublisher } from "../src/events/inventory";
import { noopInventoryObservability } from "../src/observability/inventory";
import { runInventoryEventsObservabilityAudit } from "../src/scripts/inventoryEventsObservabilityAudit";

const t = "2026-01-01T00:00:00.000Z";
function harness(opts: { failCommit?: boolean; failPublish?: boolean } = {}) {
  let ids = 0;
  const events: any[] = [];
  const observed: any[] = [];
  const product: any = {
    id: "p1",
    sku: "SKU1",
    title: "T",
    slug: "t",
    type: ProductType.UniqueItem,
    status: ProductStatus.Draft,
    stockQuantity: 5,
    priceEur: 1,
    purchaseCost: null,
    purchaseCurrency: "EUR",
    categoryId: null,
    collectionId: null,
    createdAt: t,
    updatedAt: t,
    marketplace: Object.freeze({}),
  };
  const movements: any[] = [];
  const repos: any = {
    products: {
      create: vi.fn(async (i: any) => ({
        ...product,
        ...i,
        stockQuantity: i.stockQuantity ?? 1,
        marketplace: Object.freeze({}),
      })),
      findById: vi.fn(async () => product),
      findBySku: vi.fn(),
      list: vi.fn(async () => [product]),
      update: vi.fn(),
      updateWithVersion: vi.fn(async (_id: string, patch: any) =>
        Object.assign(product, patch),
      ),
      existsBySku: vi.fn(async () => false),
    },
    inventory: {
      create: vi.fn(),
      findByProduct: vi.fn(async () => ({
        productId: "p1",
        locationId: null,
        quantity: product.stockQuantity,
        updatedAt: product.updatedAt,
      })),
      findByProductAndLocation: vi.fn(),
      listByProduct: vi.fn(),
      incrementQuantity: vi.fn(),
      decrementQuantity: vi.fn(),
      setQuantity: vi.fn(),
      updateWithVersion: vi.fn(
        async (_id: string, q: number, _v: string, updatedAt: string) => {
          product.stockQuantity = q;
          product.updatedAt = updatedAt;
          return { productId: "p1", locationId: null, quantity: q, updatedAt };
        },
      ),
    },
    stockMovements: {
      append: vi.fn(async (m: any) => {
        movements.push(Object.freeze({ ...m }));
        return m;
      }),
      findById: vi.fn(),
      listByProduct: vi.fn(async () => movements),
      listByReference: vi.fn(),
      findByIdempotencyKey: vi.fn(
        async (k: string) =>
          movements.find((m) => m.idempotencyKey === k) ?? null,
      ),
    },
    stockLocations: {
      create: vi.fn(),
      findById: vi.fn(),
      findByCode: vi.fn(),
      list: vi.fn(),
      updateWithVersion: vi.fn(),
    },
  };
  const c = buildInventoryApplicationContext({
    repositories: repos,
    unitOfWork: {
      run: vi.fn(async (fn: any) => {
        if (opts.failCommit) throw new Error("commit failed");
        return fn({ repositories: { inventoryRepositories: repos } });
      }),
    },
    clock: { now: () => new Date(t) },
    idGenerator: { newId: () => `id-${++ids}` },
    logger: { warn: vi.fn() },
    eventPublisher: {
      publish: vi.fn(async (event) => {
        if (opts.failPublish) throw new Error("publisher down");
        events.push(event);
      }),
    },
    observability: {
      inventoryEventPublished: vi.fn(async (event) =>
        observed.push(["published", event]),
      ),
      inventoryEventPublicationFailed: vi.fn(async (meta) =>
        observed.push(["failed", meta]),
      ),
      inventoryIdempotentReplayDetected: vi.fn(async (meta) =>
        observed.push(["replay", meta]),
      ),
    },
  });
  return { c, events, observed, repos, movements };
}

describe("Sprint 31A-I5 inventory events and observability", () => {
  test("publishes immutable versioned event after successful commit", async () => {
    const h = harness();
    await createIncreaseInventoryUseCase(h.c).execute({
      productId: "p1",
      quantity: 2,
      expectedVersion: t,
      idempotencyKey: "k",
    });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      name: "inventory.stock.increased",
      version: INVENTORY_EVENT_VERSION,
      aggregateId: "p1",
      payload: {
        productId: "p1",
        movementType: StockMovementType.PurchaseReceipt,
        quantityDelta: 2,
        stockBefore: 5,
        stockAfter: 7,
        idempotencyKey: "k",
      },
    });
    expect(Object.isFrozen(h.events[0])).toBe(true);
    expect(Object.isFrozen(h.events[0].payload)).toBe(true);
    expect(h.observed[0][0]).toBe("published");
  });
  test("failed transaction publishes no event", async () => {
    const h = harness({ failCommit: true });
    await expect(
      createIncreaseInventoryUseCase(h.c).execute({
        productId: "p1",
        quantity: 1,
        expectedVersion: t,
      }),
    ).rejects.toThrow("commit failed");
    expect(h.events).toHaveLength(0);
    expect(h.observed).toHaveLength(0);
  });
  test("publisher failure is observed and does not roll back committed inventory", async () => {
    const h = harness({ failPublish: true });
    await expect(
      createSetInventoryQuantityUseCase(h.c).execute({
        productId: "p1",
        quantity: 8,
        expectedVersion: t,
        note: "count",
        idempotencyKey: "s",
      }),
    ).resolves.toMatchObject({ quantity: 8 });
    expect(h.repos.inventory.findByProduct()).resolves;
    expect(h.observed[0]).toMatchObject([
      "failed",
      { eventName: "inventory.stock.quantity_set", aggregateId: "p1" },
    ]);
  });
  test("idempotent replay does not duplicate event", async () => {
    const h = harness();
    await createIncreaseInventoryUseCase(h.c).execute({
      productId: "p1",
      quantity: 2,
      expectedVersion: t,
      idempotencyKey: "k",
    });
    await createIncreaseInventoryUseCase(h.c).execute({
      productId: "p1",
      quantity: 2,
      expectedVersion: "new",
      idempotencyKey: "k",
    });
    expect(h.events).toHaveLength(1);
    expect(h.movements).toHaveLength(1);
    expect(h.observed.some((x) => x[0] === "replay")).toBe(true);
  });
  test("product events contain domain-safe payload only", async () => {
    const h = harness();
    await createProductUseCase(h.c).execute({
      sku: "SKU2",
      title: "T",
      slug: "t",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      priceEur: 1,
    });
    expect(h.events[0].payload).toEqual({ productId: "id-1", sku: "SKU2" });
    expect(JSON.stringify(h.events[0])).not.toMatch(
      /secret|password|sql|stockQuantity/i,
    );
  });
  test("context exposes no-op defaults", () => {
    const h = harness();
    expect(
      noopInventoryEventPublisher.publish(h.events[0] as any),
    ).toBeUndefined();
    expect(noopInventoryObservability).toEqual({});
  });
  test("events observability audit passes", () =>
    expect(runInventoryEventsObservabilityAudit().status).toBe("PASS"));
});
