import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import {
  auditPurchaseApplicationContextSource,
  runPurchaseApplicationContextAudit,
} from "../src/scripts/purchaseApplicationContextAudit";
import {
  buildPurchaseApplicationContext,
  type PurchaseApplicationContext,
} from "../src/services/purchaseApplicationContext";
import { createPurchaseApplicationContextForDb } from "../src/services/purchaseApplicationContextForDb";

function repos() {
  return {
    purchases: { findById: vi.fn(() => null) },
    suppliers: { findById: vi.fn(() => null) },
    receipts: { findById: vi.fn(() => null) },
  } as unknown as PurchaseApplicationContext["purchaseRepositories"];
}
function deps() {
  return {
    purchaseRepositories: repos(),
    unitOfWork: {
      run: vi.fn(async (work: any) =>
        work({ repositories: { purchaseRepositories: repos() } }),
      ),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    idGenerator: { newId: () => "id-1" },
  };
}
function sqliteDb() {
  const raw = new Database(":memory:");
  ensureSchema(raw);
  return drizzle(raw);
}

const cases: Array<[string, () => void | Promise<void>]> = [
  [
    "builds context",
    () => expect(buildPurchaseApplicationContext(deps())).toBeTruthy(),
  ],
  [
    "context is frozen",
    () =>
      expect(Object.isFrozen(buildPurchaseApplicationContext(deps()))).toBe(
        true,
      ),
  ],
  [
    "repository bundle is frozen",
    () =>
      expect(
        Object.isFrozen(
          buildPurchaseApplicationContext(deps()).purchaseRepositories,
        ),
      ).toBe(true),
  ],
  [
    "keeps injected repository bundle values",
    () => {
      const d = deps();
      expect(
        buildPurchaseApplicationContext(d).purchaseRepositories.purchases,
      ).toBe(d.purchaseRepositories.purchases);
    },
  ],
  [
    "exposes purchase repository",
    () => {
      const c = buildPurchaseApplicationContext(deps());
      expect(c.purchaseRepository).toBe(c.purchaseRepositories.purchases);
    },
  ],
  [
    "exposes supplier repository",
    () => {
      const c = buildPurchaseApplicationContext(deps());
      expect(c.supplierRepository).toBe(c.purchaseRepositories.suppliers);
    },
  ],
  [
    "exposes purchase receipt repository",
    () => {
      const c = buildPurchaseApplicationContext(deps());
      expect(c.purchaseReceiptRepository).toBe(c.purchaseRepositories.receipts);
    },
  ],
  [
    "exposes unit of work",
    () => {
      const d = deps();
      expect(buildPurchaseApplicationContext(d).unitOfWork).toBe(d.unitOfWork);
    },
  ],
  [
    "exposes logger",
    () => {
      const d = deps();
      expect(buildPurchaseApplicationContext(d).logger).toBe(d.logger);
    },
  ],
  [
    "exposes clock",
    () =>
      expect(
        buildPurchaseApplicationContext(deps()).clock.now().toISOString(),
      ).toBe("2026-01-01T00:00:00.000Z"),
  ],
  [
    "exposes id generator",
    () =>
      expect(buildPurchaseApplicationContext(deps()).idGenerator.newId()).toBe(
        "id-1",
      ),
  ],
  [
    "defaults configuration",
    () =>
      expect(
        buildPurchaseApplicationContext(deps()).configuration
          .purchaseApplicationContext,
      ).toBe(true),
  ],
  [
    "keeps injected configuration",
    () => {
      const configuration = {
        purchaseApplicationContext: true as const,
        driver: "sqlite",
      };
      expect(
        buildPurchaseApplicationContext({ ...deps(), configuration })
          .configuration,
      ).toBe(configuration);
    },
  ],
  [
    "missing repositories rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          purchaseRepositories: undefined as never,
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_purchaseRepositories"),
  ],
  [
    "missing unit of work rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          unitOfWork: undefined as never,
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_unitOfWork"),
  ],
  [
    "missing logger rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          logger: undefined as never,
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_logger"),
  ],
  [
    "missing clock rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          clock: undefined as never,
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_clock"),
  ],
  [
    "missing id generator rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          idGenerator: undefined as never,
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_idGenerator"),
  ],
  [
    "missing purchase repository rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          purchaseRepositories: { ...repos(), purchases: undefined as never },
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_REPOSITORY_purchases"),
  ],
  [
    "missing supplier repository rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          purchaseRepositories: { ...repos(), suppliers: undefined as never },
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_REPOSITORY_suppliers"),
  ],
  [
    "missing receipt repository rejected",
    () =>
      expect(() =>
        buildPurchaseApplicationContext({
          ...deps(),
          purchaseRepositories: { ...repos(), receipts: undefined as never },
        }),
      ).toThrow("PURCHASE_APPLICATION_CONTEXT_MISSING_REPOSITORY_receipts"),
  ],
  [
    "logger methods callable",
    () => {
      const c = buildPurchaseApplicationContext(deps());
      c.logger.info?.("purchase", { id: "p" });
      expect(c.logger.info).toHaveBeenCalledWith("purchase", { id: "p" });
    },
  ],
  [
    "empty logger accepted",
    () =>
      expect(
        buildPurchaseApplicationContext({ ...deps(), logger: {} }).logger,
      ).toEqual({}),
  ],
  [
    "unit of work run is untouched",
    async () => {
      const d = deps();
      await buildPurchaseApplicationContext(d).unitOfWork.run(async () => "ok");
      expect(d.unitOfWork.run).toHaveBeenCalled();
    },
  ],
  [
    "no aliases named repositories",
    () =>
      expect("repositories" in buildPurchaseApplicationContext(deps())).toBe(
        false,
      ),
  ],
  [
    "no inventory repository leakage",
    () =>
      expect(
        "inventoryRepository" in buildPurchaseApplicationContext(deps()),
      ).toBe(false),
  ],
  [
    "no refund repository leakage",
    () =>
      expect(
        "refundRepository" in buildPurchaseApplicationContext(deps()),
      ).toBe(false),
  ],
  [
    "contract only keys",
    () =>
      expect(
        Object.keys(buildPurchaseApplicationContext(deps())).sort(),
      ).toEqual(
        [
          "clock",
          "configuration",
          "eventPublisher",
          "idGenerator",
          "logger",
          "observability",
          "purchaseReceiptRepository",
          "purchaseRepositories",
          "purchaseRepository",
          "supplierRepository",
          "unitOfWork",
        ].sort(),
      ),
  ],
  [
    "db factory builds sqlite context",
    () =>
      expect(
        createPurchaseApplicationContextForDb(sqliteDb()).configuration.driver,
      ).toBe("sqlite"),
  ],
  [
    "db factory supports object input",
    () =>
      expect(
        createPurchaseApplicationContextForDb({
          db: sqliteDb(),
          driver: "sqlite",
        }).purchaseRepository.findById("x"),
      ).toBeNull(),
  ],
  [
    "db factory injects logger",
    () => {
      const logger = { warn: vi.fn() };
      expect(
        createPurchaseApplicationContextForDb({ db: sqliteDb(), logger })
          .logger,
      ).toBe(logger);
    },
  ],
  [
    "db factory injects unit of work",
    () => {
      const unitOfWork = { run: vi.fn() } as never;
      expect(
        createPurchaseApplicationContextForDb({ db: sqliteDb(), unitOfWork })
          .unitOfWork,
      ).toBe(unitOfWork);
    },
  ],
  [
    "db factory clock is available",
    () =>
      expect(
        createPurchaseApplicationContextForDb(sqliteDb()).clock.now(),
      ).toBeInstanceOf(Date),
  ],
  [
    "db factory id generator is available",
    () =>
      expect(
        createPurchaseApplicationContextForDb(sqliteDb()).idGenerator.newId(),
      ).toMatch(/[0-9a-f-]{36}/),
  ],
  [
    "db factory freezes context",
    () =>
      expect(
        Object.isFrozen(createPurchaseApplicationContextForDb(sqliteDb())),
      ).toBe(true),
  ],
  [
    "db factory freezes repositories",
    () =>
      expect(
        Object.isFrozen(
          createPurchaseApplicationContextForDb(sqliteDb())
            .purchaseRepositories,
        ),
      ).toBe(true),
  ],
  [
    "sqlite purchase repository compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb(
          sqliteDb(),
        ).purchaseRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "sqlite supplier repository compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb(
          sqliteDb(),
        ).supplierRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "sqlite receipt repository compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb(
          sqliteDb(),
        ).purchaseReceiptRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "postgres driver compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb({
          db: sqliteDb(),
          driver: "postgres",
        }).purchaseRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "test-memory driver compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb({
          db: sqliteDb(),
          driver: "test-memory",
        }).supplierRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "supabase-postgres driver compatibility",
    () =>
      expect(
        createPurchaseApplicationContextForDb({
          db: sqliteDb(),
          driver: "supabase-postgres",
        }).purchaseReceiptRepository.findById("missing"),
      ).toBeNull(),
  ],
  [
    "audit passes source",
    () => expect(runPurchaseApplicationContextAudit().status).toBe("PASS"),
  ],
  [
    "audit rejects SQL",
    () =>
      expect(
        auditPurchaseApplicationContextSource("select * from purchases").issues,
      ).toContain("SQL"),
  ],
  [
    "audit rejects schema",
    () =>
      expect(
        auditPurchaseApplicationContextSource(
          "import { purchases } from '../db/schema'",
        ).issues,
      ).toContain("schema"),
  ],
  [
    "audit rejects DbClient",
    () =>
      expect(
        auditPurchaseApplicationContextSource("type X = DbClient").issues,
      ).toContain("DbClient"),
  ],
  [
    "audit rejects Drizzle",
    () =>
      expect(auditPurchaseApplicationContextSource("Drizzle").issues).toContain(
        "Drizzle",
      ),
  ],
  [
    "audit rejects repository implementation",
    () =>
      expect(
        auditPurchaseApplicationContextSource(
          "createPurchaseRepositoriesForDb(db)",
        ).issues,
      ).toContain("repository implementation"),
  ],
  [
    "audit rejects service construction",
    () =>
      expect(
        auditPurchaseApplicationContextSource("new PurchaseService()").issues,
      ).toContain("service construction"),
  ],
  [
    "audit rejects HTTP",
    () =>
      expect(
        auditPurchaseApplicationContextSource("fetch('/x')").issues,
      ).toContain("HTTP"),
  ],
  [
    "audit rejects provider SDK",
    () =>
      expect(
        auditPurchaseApplicationContextSource("stripe.refunds.create()").issues,
      ).toContain("provider SDK"),
  ],
  [
    "audit rejects AI SDK",
    () =>
      expect(
        auditPurchaseApplicationContextSource("import OpenAI from 'openai'")
          .issues,
      ).toContain("AI SDK"),
  ],
  [
    "audit rejects environment loading",
    () =>
      expect(
        auditPurchaseApplicationContextSource("process.env.X").issues,
      ).toContain("environment loading"),
  ],
];

describe("Sprint 32A-P2 Purchase application context", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run();
  });
  it("database context accepts purchase event publisher", () => {
    const publisher = { publish: vi.fn() };
    const c = createPurchaseApplicationContextForDb({ db: sqliteDb(), eventPublisher: publisher });
    expect(c.eventPublisher).toBe(publisher);
  });
  it("database context accepts purchase observability", () => {
    const observability = { purchaseEventPublished: vi.fn() };
    const c = createPurchaseApplicationContextForDb({ db: sqliteDb(), observability });
    expect(c.observability).toBe(observability);
  });

});
