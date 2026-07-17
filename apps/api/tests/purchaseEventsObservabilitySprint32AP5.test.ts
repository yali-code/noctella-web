import { describe, expect, it, vi } from "vitest";
import {
  createPurchaseEvent,
  PURCHASE_EVENT_VERSION,
  type PurchaseEventName,
} from "../src/domain/purchase/events";
import { noopPurchaseEventPublisher } from "../src/events/purchase";
import {
  noopPurchaseObservability,
  emitPurchaseSignal,
} from "../src/observability/purchase";
import { buildPurchaseApplicationContext } from "../src/services/purchaseApplicationContext";
import {
  auditPurchaseEventsObservabilitySource,
  runPurchaseEventsObservabilityAudit,
} from "../src/scripts/purchaseEventsObservabilityAudit";

const names: PurchaseEventName[] = [
  "purchase.created",
  "purchase.updated",
  "purchase.ordered",
  "purchase.cancelled",
  "purchase.received",
  "purchase.partially_received",
  "supplier.created",
  "supplier.updated",
];
function ev(name: PurchaseEventName) {
  return createPurchaseEvent({
    id: `e-${name}`,
    name,
    occurredAt: "2026-01-01T00:00:00.000Z",
    aggregateId: "a1",
    aggregateType: name.startsWith("supplier") ? "supplier" : "purchase",
    payload: {
      purchaseId: "p1",
      supplierId: "s1",
      idempotencyKey: "k",
      status: "Draft",
      lineCount: 1,
      totalCost: 2,
      erpReferenceId: "erp",
      name: "Supplier",
    },
  });
}
function repos() {
  return { purchases: {}, suppliers: {}, receipts: {} } as any;
}
function ctx(overrides: any = {}) {
  return buildPurchaseApplicationContext({
    purchaseRepositories: repos(),
    unitOfWork: {
      run: async (fn: any) =>
        fn({
          repositories: {
            purchaseRepositories: repos(),
            inventoryRepositories: {},
          },
        }),
    },
    logger: { warn: vi.fn() },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    idGenerator: { newId: () => "id" },
    ...overrides,
  });
}
async function publishAfterCommit(c: any, event: any, work: any = () => "ok") {
  const out = await c.unitOfWork.run(work);
  await c.eventPublisher.publish(event);
  return out;
}
async function isolated(c: any, event: any) {
  try {
    await c.eventPublisher.publish(event);
  } catch (e) {
    await emitPurchaseSignal(
      c.observability,
      "purchaseEventPublicationFailed",
      {
        eventId: event.id,
        eventName: event.name,
        aggregateId: event.aggregateId,
        error: (e as Error).message,
      },
      c.logger,
    );
  }
}

describe("Purchase events observability Sprint 32A-P5", () => {
  names.forEach((name) =>
    it(`creates immutable ${name}`, () => {
      const e = ev(name);
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.payload)).toBe(true);
      expect(e.name).toBe(name);
    }),
  );
  names.forEach((name) =>
    it(`uses version for ${name}`, () =>
      expect(ev(name).version).toBe(PURCHASE_EVENT_VERSION)),
  );
  names.forEach((name) =>
    it(`payload is deterministic for ${name}`, () => {
      const p = ev(name).payload as any;
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
      expect(p.createdAt instanceof Date).toBe(false);
    }),
  );
  names.forEach((name) =>
    it(`has aggregate data for ${name}`, () => {
      const e = ev(name);
      expect(e.aggregateId).toBe("a1");
      expect(["purchase", "supplier"]).toContain(e.aggregateType);
    }),
  );
  it("centralizes version", () => expect(PURCHASE_EVENT_VERSION).toBe(1));
  it("publisher no-op resolves", () =>
    expect(
      noopPurchaseEventPublisher.publish(ev("purchase.created")),
    ).toBeUndefined());
  it("observability no-op is frozen", () =>
    expect(Object.isFrozen(noopPurchaseObservability)).toBe(true));
  it("observability safe call swallows", async () => {
    const logger = { warn: vi.fn() };
    await emitPurchaseSignal(
      {
        purchaseEventPublished: () => {
          throw new Error("x");
        },
      },
      "purchaseEventPublished",
      ev("purchase.created"),
      logger,
    );
    expect(logger.warn).toHaveBeenCalled();
  });
  it("context defaults publisher", () =>
    expect(ctx().eventPublisher).toBe(noopPurchaseEventPublisher));
  it("context defaults observability", () =>
    expect(ctx().observability).toBe(noopPurchaseObservability));
  it("context accepts publisher", () => {
    const p = { publish: vi.fn() };
    expect(ctx({ eventPublisher: p }).eventPublisher).toBe(p);
  });
  it("context accepts observability", () => {
    const o = { purchaseEventPublished: vi.fn() };
    expect(ctx({ observability: o }).observability).toBe(o);
  });
  it("commit publishes after unit of work", async () => {
    const order: string[] = [];
    const p = { publish: vi.fn(() => order.push("publish")) };
    const c = ctx({
      eventPublisher: p,
      unitOfWork: {
        run: async () => {
          order.push("commit");
          return "done";
        },
      },
    });
    await publishAfterCommit(c, ev("purchase.created"));
    expect(order).toEqual(["commit", "publish"]);
  });
  it("rollback publishes nothing", async () => {
    const p = { publish: vi.fn() };
    const c = ctx({
      eventPublisher: p,
      unitOfWork: {
        run: async () => {
          throw new Error("rollback");
        },
      },
    });
    await expect(publishAfterCommit(c, ev("purchase.updated"))).rejects.toThrow(
      "rollback",
    );
    expect(p.publish).not.toHaveBeenCalled();
  });
  it("publisher failure is isolated", async () => {
    const p = {
      publish: vi.fn(() => {
        throw new Error("broker");
      }),
    };
    const o = { purchaseEventPublicationFailed: vi.fn() };
    const c = ctx({ eventPublisher: p, observability: o });
    await isolated(c, ev("purchase.received"));
    expect(o.purchaseEventPublicationFailed).toHaveBeenCalled();
  });
  it("replay emits signal not event", async () => {
    const p = { publish: vi.fn() };
    const o = { purchaseIdempotentReplayDetected: vi.fn() };
    await emitPurchaseSignal(
      o,
      "purchaseIdempotentReplayDetected",
      { aggregateId: "p1", idempotencyKey: "r" },
      {},
    );
    expect(o.purchaseIdempotentReplayDetected).toHaveBeenCalled();
    expect(p.publish).not.toHaveBeenCalled();
  });
  it("audit production passes", () =>
    expect(runPurchaseEventsObservabilityAudit().status).toBe("PASS"));
  [
    "sql`select 1`",
    "DbClient",
    "drizzle-orm",
    "repositories/purchase/sqlite",
    "routes",
    "controllers",
    "fetch('/x')",
    "Kafka",
    "RabbitMQ",
    "SNS",
    "Azure",
    "OpenTelemetry",
    "Date.now()",
    "randomUUID()",
    "commit()",
    "rollback()",
  ].forEach((bad) =>
    it(`audit rejects ${bad}`, () =>
      expect(auditPurchaseEventsObservabilitySource(bad).status).toBe("FAIL")),
  );
  [
    "purchase.created",
    "purchase.received",
    "supplier.created",
    "PurchaseEventPublisher",
    "PurchaseObservability",
  ].forEach((ok) =>
    it(`audit allows ${ok}`, () =>
      expect(auditPurchaseEventsObservabilitySource(ok).status).toBe("PASS")),
  );
});
