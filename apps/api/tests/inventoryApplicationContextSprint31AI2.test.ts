import { describe, expect, test, vi } from "vitest";
import { auditInventoryApplicationContextSource, runInventoryApplicationContextAudit } from "../src/scripts/inventoryApplicationContextAudit";
import { buildInventoryApplicationContext, type BuildInventoryApplicationContextInput, type InventoryApplicationContext, type InventoryClock, type InventoryIdGenerator, type InventoryLogger } from "../src/services/inventoryApplicationContext";

function repo(methods: string[]) {
  return Object.fromEntries(methods.map((name) => [name, vi.fn()])) as never;
}

function deps(): BuildInventoryApplicationContextInput {
  return {
    repositories: {
      products: repo(["create", "findById", "findBySku", "list", "update", "updateWithVersion", "existsBySku"]),
      inventory: repo(["create", "findByProduct", "findByProductAndLocation", "listByProduct", "incrementQuantity", "decrementQuantity", "setQuantity", "updateWithVersion"]),
      stockMovements: repo(["append", "findById", "listByProduct", "listByReference", "findByIdempotencyKey"]),
      stockLocations: repo(["create", "findById", "findByCode", "list", "updateWithVersion"]),
    },
    unitOfWork: { run: vi.fn(async (work) => work({ repositories: {} as never })) },
    clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00.000Z")) },
    idGenerator: { newId: vi.fn(() => "inventory-id-1") },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    configuration: { inventoryApplicationContext: true },
  };
}

const forbiddenRuntimeKeys = ["db", "client", "schema", "sql", "drizzle", "transaction", "commit", "rollback"];

describe("Sprint 31A-I2 Inventory application context", () => {
  test("builds context", () => expect(buildInventoryApplicationContext(deps())).toBeTruthy());
  test("context is frozen", () => expect(Object.isFrozen(buildInventoryApplicationContext(deps()))).toBe(true));
  test("repository bundle is frozen", () => expect(Object.isFrozen(buildInventoryApplicationContext(deps()).repositories)).toBe(true));
  test("repositories cannot be replaced", () => { const c = buildInventoryApplicationContext(deps()) as InventoryApplicationContext & { repositories: unknown }; expect(() => { c.repositories = {}; }).toThrow(); });
  test("product alias is products repository", () => { const d = deps(); expect(buildInventoryApplicationContext(d).productRepository).toBe(d.repositories.products); });
  test("inventory alias is inventory repository", () => { const d = deps(); expect(buildInventoryApplicationContext(d).inventoryRepository).toBe(d.repositories.inventory); });
  test("stock movement alias is stockMovements repository", () => { const d = deps(); expect(buildInventoryApplicationContext(d).stockMovementRepository).toBe(d.repositories.stockMovements); });
  test("stock location alias is stockLocations repository", () => { const d = deps(); expect(buildInventoryApplicationContext(d).stockLocationRepository).toBe(d.repositories.stockLocations); });
  test("unit of work exposure", () => { const d = deps(); expect(buildInventoryApplicationContext(d).unitOfWork).toBe(d.unitOfWork); });
  test("unit of work is not recreated", () => { const d = deps(); expect(buildInventoryApplicationContext(d).unitOfWork.run).toBe(d.unitOfWork.run); });
  test("clock exposure", () => expect(buildInventoryApplicationContext(deps()).clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z"));
  test("id generator exposure", () => expect(buildInventoryApplicationContext(deps()).idGenerator.newId()).toBe("inventory-id-1"));
  test("logger exposure", () => { const c = buildInventoryApplicationContext(deps()); c.logger.info?.("ready"); expect(c.logger.info).toHaveBeenCalledWith("ready"); });
  test("configuration exposure", () => expect(buildInventoryApplicationContext(deps()).configuration.inventoryApplicationContext).toBe(true));
  test("default configuration is safe", () => { const d = deps(); delete (d as Partial<BuildInventoryApplicationContextInput>).configuration; expect(buildInventoryApplicationContext(d).configuration).toEqual({ inventoryApplicationContext: true }); });
  test("default configuration is frozen", () => { const d = deps(); delete (d as Partial<BuildInventoryApplicationContextInput>).configuration; expect(Object.isFrozen(buildInventoryApplicationContext(d).configuration)).toBe(true); });
  test.each(["repositories", "unitOfWork", "clock", "idGenerator", "logger"] as const)("missing dependency %s", (key) => expect(() => buildInventoryApplicationContext({ ...deps(), [key]: undefined as never })).toThrow(`INVENTORY_APPLICATION_CONTEXT_MISSING_${key}`));
  test.each(["products", "inventory", "stockMovements", "stockLocations"] as const)("missing repository %s", (key) => { const d = deps(); (d.repositories as Record<string, unknown>)[key] = undefined; expect(() => buildInventoryApplicationContext(d)).toThrow(`INVENTORY_APPLICATION_CONTEXT_MISSING_REPOSITORY_${key}`); });
  test("multiple contexts are distinct", () => expect(buildInventoryApplicationContext(deps())).not.toBe(buildInventoryApplicationContext(deps())));
  test("multiple contexts keep isolated bundles", () => expect(buildInventoryApplicationContext(deps()).repositories).not.toBe(buildInventoryApplicationContext(deps()).repositories));
  test("same input repositories are copied before freezing", () => { const d = deps(); expect(buildInventoryApplicationContext(d).repositories).not.toBe(d.repositories); });
  test("same input repository members are preserved", () => { const d = deps(); expect(buildInventoryApplicationContext(d).repositories.products).toBe(d.repositories.products); });
  test("product repository contract only", () => expect(Object.keys(buildInventoryApplicationContext(deps()).productRepository).sort()).toEqual(["create", "existsBySku", "findById", "findBySku", "list", "update", "updateWithVersion"].sort()));
  test("inventory repository contract only", () => expect(Object.keys(buildInventoryApplicationContext(deps()).inventoryRepository).sort()).toEqual(["create", "decrementQuantity", "findByProduct", "findByProductAndLocation", "incrementQuantity", "listByProduct", "setQuantity", "updateWithVersion"].sort()));
  test("stock movement repository contract only", () => expect(Object.keys(buildInventoryApplicationContext(deps()).stockMovementRepository).sort()).toEqual(["append", "findById", "findByIdempotencyKey", "listByProduct", "listByReference"].sort()));
  test("stock location repository contract only", () => expect(Object.keys(buildInventoryApplicationContext(deps()).stockLocationRepository).sort()).toEqual(["create", "findByCode", "findById", "list", "updateWithVersion"].sort()));
  test("no forbidden product runtime keys", () => expect(Object.keys(buildInventoryApplicationContext(deps()).productRepository).some((k) => forbiddenRuntimeKeys.includes(k))).toBe(false));
  test("no forbidden inventory runtime keys", () => expect(Object.keys(buildInventoryApplicationContext(deps()).inventoryRepository).some((k) => forbiddenRuntimeKeys.includes(k))).toBe(false));
  test("no forbidden stock movement runtime keys", () => expect(Object.keys(buildInventoryApplicationContext(deps()).stockMovementRepository).some((k) => forbiddenRuntimeKeys.includes(k))).toBe(false));
  test("no forbidden stock location runtime keys", () => expect(Object.keys(buildInventoryApplicationContext(deps()).stockLocationRepository).some((k) => forbiddenRuntimeKeys.includes(k))).toBe(false));
  test("factory behavior preserves optional logger", () => expect(buildInventoryApplicationContext({ ...deps(), logger: {} }).logger).toEqual({}));
  test("factory behavior preserves typed clock", () => { const clock: InventoryClock = { now: () => new Date("2026-02-03T00:00:00.000Z") }; expect(buildInventoryApplicationContext({ ...deps(), clock }).clock).toBe(clock); });
  test("factory behavior preserves typed id generator", () => { const idGenerator: InventoryIdGenerator = { newId: () => "typed" }; expect(buildInventoryApplicationContext({ ...deps(), idGenerator }).idGenerator).toBe(idGenerator); });
  test("factory behavior preserves typed logger", () => { const logger: InventoryLogger = { warn: vi.fn() }; expect(buildInventoryApplicationContext({ ...deps(), logger }).logger).toBe(logger); });
  test("unit of work run remains callable", async () => { const c = buildInventoryApplicationContext(deps()); await c.unitOfWork.run(async () => "ok"); expect(c.unitOfWork.run).toHaveBeenCalled(); });
  test("repository bundle exposes expected top-level names", () => expect(Object.keys(buildInventoryApplicationContext(deps()).repositories).sort()).toEqual(["inventory", "products", "stockLocations", "stockMovements"].sort()));
  test("context exposes stable dependency names", () => expect(Object.keys(buildInventoryApplicationContext(deps())).sort()).toEqual(["clock", "configuration", "idGenerator", "inventoryRepository", "logger", "productRepository", "repositories", "stockLocationRepository", "stockMovementRepository", "unitOfWork"].sort()));
  test("audit passes", () => expect(runInventoryApplicationContextAudit().status).toBe("PASS"));
  test("audit rejects forbidden tokens", () => expect(auditInventoryApplicationContextSource("db.transaction(() => fetch('x'))").status).toBe("FAIL"));
  test("audit reports forbidden token names", () => expect(auditInventoryApplicationContextSource("import { sql } from 'drizzle-orm';").issues).toEqual(expect.arrayContaining(["SQL", "Drizzle"])));
  test("builder result is stable for equal dependencies", () => { const d = deps(); expect(buildInventoryApplicationContext(d)).toEqual(buildInventoryApplicationContext(d)); });
  test("builder does not add data access keys", () => expect(JSON.stringify(Object.keys(buildInventoryApplicationContext(deps())))).not.toMatch(/db|sql|schema|drizzle/i));
});
