import { describe, it, expect, vi } from "vitest";
import * as uc from "../src/application/purchase";
import { increaseInventoryInTransactionUseCase } from "../src/application/inventory";
const t = "2026-01-01T00:00:00.000Z";
function ctx() {
  let n = 0;
  const purchases = new Map<string, any>(),
    suppliers = new Map<string, any>(),
    receipts = new Map<string, any>(),
    inv = new Map<string, any>([
      ["prod", { productId: "prod", quantity: 0, updatedAt: t }],
    ]),
    moves: any[] = [];
  const pr: any = {
    create: vi.fn((i) => {
      if (
        i.erpReferenceId &&
        [...purchases.values()].some(
          (p) => p.erpReferenceId === i.erpReferenceId,
        )
      )
        throw new Error("dup");
      const p = Object.freeze({
        ...i,
        lines: Object.freeze(
          i.lines.map((l: any) => Object.freeze({ ...l, purchaseId: i.id })),
        ),
      });
      purchases.set(i.id, p);
      return p;
    }),
    findById: vi.fn((id) => purchases.get(id) ?? null),
    findByReference: vi.fn(
      (ref) =>
        [...purchases.values()].find((p) =>
          [
            p.erpReferenceId,
            p.externalReference,
            p.invoiceReferenceNumber,
          ].includes(ref),
        ) ?? null,
    ),
    existsByReference: vi.fn(
      (ref) => !![...purchases.values()].find((p) => p.erpReferenceId === ref),
    ),
    list: vi.fn((q: any = {}) => ({
      rows: [...purchases.values()].filter(
        (p) =>
          (!q.status || p.status === q.status) &&
          (!q.supplierId || p.supplierId === q.supplierId),
      ),
      total: purchases.size,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })),
    update: vi.fn((id, patch) => {
      const p = purchases.get(id);
      if (!p) return null;
      const np = Object.freeze({ ...p, ...patch });
      purchases.set(id, np);
      return np;
    }),
    updateWithVersion: vi.fn((id, ver, patch) => {
      const p = purchases.get(id);
      if (!p) return { ok: false, issue: { code: "not_found" } };
      if (p.updatedAt !== ver)
        return { ok: false, issue: { code: "optimistic_conflict" } };
      const np = Object.freeze({ ...p, ...patch });
      purchases.set(id, np);
      return { ok: true, value: np };
    }),
    addLine: vi.fn((l) => {
      const p = purchases.get(l.purchaseId);
      const line = Object.freeze({ ...l });
      purchases.set(
        p.id,
        Object.freeze({ ...p, lines: Object.freeze([...p.lines, line]) }),
      );
      return line;
    }),
    updateLine: vi.fn((id, patch) => {
      for (const p of purchases.values()) {
        const i = p.lines.findIndex((l: any) => l.id === id);
        if (i >= 0) {
          const line = Object.freeze({ ...p.lines[i], ...patch });
          const lines = [...p.lines];
          lines[i] = line;
          purchases.set(
            p.id,
            Object.freeze({ ...p, lines: Object.freeze(lines) }),
          );
          return line;
        }
      }
      return null;
    }),
    removeLine: vi.fn((id) => {
      for (const p of purchases.values()) {
        if (p.lines.some((l: any) => l.id === id)) {
          purchases.set(
            p.id,
            Object.freeze({
              ...p,
              lines: Object.freeze(p.lines.filter((l: any) => l.id !== id)),
            }),
          );
          return true;
        }
      }
      return false;
    }),
  };
  const sr: any = {
    create: vi.fn((i) => {
      const s = Object.freeze({ ...i });
      suppliers.set(i.id, s);
      return s;
    }),
    findById: vi.fn((id) => suppliers.get(id) ?? null),
    findByCode: vi.fn(),
    findByName: vi.fn(),
    list: vi.fn(() =>
      [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ),
    existsByCode: vi.fn(),
    update: vi.fn((id, patch) => {
      const s = suppliers.get(id);
      if (!s) return null;
      const ns = Object.freeze({ ...s, ...patch });
      suppliers.set(id, ns);
      return ns;
    }),
    updateWithVersion: vi.fn((id, ver, patch) => {
      const s = suppliers.get(id);
      if (!s) return { ok: false, issue: { code: "not_found" } };
      if (s.updatedAt !== ver)
        return { ok: false, issue: { code: "optimistic_conflict" } };
      const ns = Object.freeze({ ...s, ...patch });
      suppliers.set(id, ns);
      return { ok: true, value: ns };
    }),
  };
  const rr: any = {
    append: vi.fn((i) => {
      if (receipts.has(i.idempotencyKey)) throw new Error("dup");
      const r = Object.freeze({ ...i, lines: Object.freeze(i.lines) });
      receipts.set(i.idempotencyKey, r);
      return r;
    }),
    findById: vi.fn(),
    findByIdempotencyKey: vi.fn((k) => receipts.get(k) ?? null),
    listByPurchase: vi.fn((id) =>
      [...receipts.values()].filter((r) => r.purchaseId === id),
    ),
    listByPurchaseLine: vi.fn(),
    listByReference: vi.fn(),
  };
  const repos = { purchases: pr, suppliers: sr, receipts: rr };
  const inventoryRepositories: any = {
    inventory: {
      findByProduct: vi.fn((id: string) => inv.get(id) ?? null),
      updateWithVersion: vi.fn((id: string, q: number, _v: string, updatedAt: string) => {
        const x = { productId: id, quantity: q, updatedAt };
        inv.set(id, x);
        return x;
      }),
    },
    stockMovements: { append: vi.fn((m: any) => { moves.push(m); return m; }) },
  };
  const uow = {
    run: vi.fn(async (fn: any) =>
      fn({
        repositories: {
          purchaseRepositories: repos,
        },
      }),
    ),
  };
  return {
    c: {
      purchaseRepositories: repos,
      purchaseRepository: pr,
      supplierRepository: sr,
      purchaseReceiptRepository: rr,
      unitOfWork: uow,
      inventoryReceiptMutation: (_db: any, inventoryContext: any, mutation: any) =>
        increaseInventoryInTransactionUseCase(inventoryContext, inventoryRepositories, mutation),
      clock: { now: () => new Date(t) },
      idGenerator: { newId: () => `id-${++n}` },
      logger: {},
      configuration: { purchaseApplicationContext: true },
    },
    repos,
    uow,
    purchases,
    suppliers,
    receipts,
    inv,
    moves,
  };
}
async function purchase(x = ctx()) {
  return uc
    .createPurchaseUseCase(x.c as any)
    .execute({
      lines: [
        {
          productId: "prod",
          titleSnapshot: "A",
          quantity: 2,
          unitPurchaseCost: 5,
        },
      ],
    });
}
describe("Purchase use cases Sprint 32A-P3", () => {
  it("creates supplier minimum", async () => {
    const x = ctx();
    const s = await uc
      .createSupplierUseCase(x.c as any)
      .execute({ name: " Acme " });
    expect(s).toMatchObject({
      id: "id-1",
      normalizedName: "acme",
      status: "Active",
    });
    expect(x.uow.run).toHaveBeenCalledTimes(1);
  });
  it("updates supplier", async () => {
    const x = ctx();
    const s = await uc.createSupplierUseCase(x.c as any).execute({ name: "A" });
    await expect(
      uc
        .updateSupplierUseCase(x.c as any)
        .execute({ id: s.id, name: "B", expectedVersion: t }),
    ).resolves.toMatchObject({ name: "B" });
  });
  it("rejects stale supplier", async () => {
    const x = ctx();
    const s = await uc.createSupplierUseCase(x.c as any).execute({ name: "A" });
    await expect(
      uc
        .updateSupplierUseCase(x.c as any)
        .execute({ id: s.id, expectedVersion: "old" }),
    ).rejects.toThrow("changed");
  });
  it("lists suppliers sorted", async () => {
    const x = ctx();
    await uc.createSupplierUseCase(x.c as any).execute({ name: "B" });
    await uc.createSupplierUseCase(x.c as any).execute({ name: "A" });
    expect(
      (await uc.listSuppliersUseCase(x.c as any).execute()).map((s) => s.name),
    ).toEqual(["A", "B"]);
  });
  it("gets missing supplier", async () => {
    await expect(
      uc.getSupplierUseCase(ctx().c as any).execute({ id: "none" }),
    ).rejects.toThrow("Supplier not found");
  });
  it("creates purchase minimum", async () => {
    const x = ctx();
    const p = await purchase(x);
    expect(p).toMatchObject({
      id: "id-1",
      currency: "EUR",
      itemSubtotal: 10,
      totalCost: null,
      status: "Draft",
    });
    expect(p.lines[0].id).toBe("id-2");
  });
  it("rejects non EUR", async () => {
    await expect(
      uc
        .createPurchaseUseCase(ctx().c as any)
        .execute({
          currency: "USD" as any,
          lines: [{ titleSnapshot: "A", quantity: 1, unitPurchaseCost: 1 }],
        }),
    ).rejects.toThrow("EUR");
  });
  it("preserves optional supplier and product", async () => {
    const p = await uc
      .createPurchaseUseCase(ctx().c as any)
      .execute({
        supplierId: null,
        lines: [
          {
            productId: null,
            titleSnapshot: "Free",
            quantity: 1,
            unitPurchaseCost: 1,
          },
        ],
      });
    expect(p.supplierId).toBeNull();
    expect(p.lines[0].productId).toBeNull();
  });
  it("supports multiple lines and total", async () => {
    const p = await uc.createPurchaseUseCase(ctx().c as any).execute({
      shippingCost: 2,
      buyerPremium: 1,
      customsCost: 0,
      packagingCost: 0,
      taxVat: 0,
      miscellaneousCost: 0,
      lines: [
        { titleSnapshot: "A", quantity: 1, unitPurchaseCost: 3 },
        { titleSnapshot: "B", quantity: 2, unitPurchaseCost: 4 },
      ],
    });
    expect(p.totalCost).toBe(14);
  });
  it("rejects empty lines", async () => {
    await expect(
      uc.createPurchaseUseCase(ctx().c as any).execute({ lines: [] }),
    ).rejects.toThrow("at least one");
  });
  it("rejects invalid quantity", async () => {
    await expect(
      uc
        .createPurchaseUseCase(ctx().c as any)
        .execute({
          lines: [{ titleSnapshot: "A", quantity: 0, unitPurchaseCost: 1 }],
        }),
    ).rejects.toThrow("quantity");
  });
  it("rejects negative cost", async () => {
    await expect(
      uc
        .createPurchaseUseCase(ctx().c as any)
        .execute({
          lines: [{ titleSnapshot: "A", quantity: 1, unitPurchaseCost: -1 }],
        }),
    ).rejects.toThrow("negative");
  });
  it("updates purchase", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .updatePurchaseUseCase(x.c as any)
        .execute({ id: p.id, notes: "n", expectedVersion: t }),
    ).resolves.toMatchObject({ notes: "n" });
  });
  it("rejects stale purchase", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .updatePurchaseUseCase(x.c as any)
        .execute({ id: p.id, expectedVersion: "old" }),
    ).rejects.toThrow("changed");
  });
  it("rejects update after ordered", async () => {
    const x = ctx();
    const p = await purchase(x);
    await uc.markPurchaseOrderedUseCase(x.c as any).execute({ id: p.id });
    await expect(
      uc.updatePurchaseUseCase(x.c as any).execute({ id: p.id, notes: "x" }),
    ).rejects.toThrow("current status");
  });
  it("adds line", async () => {
    const x = ctx();
    const p = await purchase(x);
    const l = await uc
      .addPurchaseLineUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        titleSnapshot: "B",
        quantity: 1,
        unitPurchaseCost: 1,
      });
    expect(l.purchaseId).toBe(p.id);
    expect(x.repos.purchases.findById(p.id).lines).toHaveLength(2);
  });
  it("updates line", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .updatePurchaseLineUseCase(x.c as any)
        .execute({
          purchaseId: p.id,
          lineId: p.lines[0].id,
          titleSnapshot: "C",
        }),
    ).resolves.toMatchObject({ titleSnapshot: "C" });
  });
  it("removes line", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .removePurchaseLineUseCase(x.c as any)
        .execute({ purchaseId: p.id, lineId: p.lines[0].id }),
    ).resolves.toMatchObject({ removed: true });
  });
  it("rejects missing line", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .updatePurchaseLineUseCase(x.c as any)
        .execute({ purchaseId: p.id, lineId: "bad" }),
    ).rejects.toThrow("Purchase not found");
  });
  it("marks ordered", async () => {
    const x = ctx();
    const p = await purchase(x);
    const o = await uc
      .markPurchaseOrderedUseCase(x.c as any)
      .execute({ id: p.id });
    expect(o.status).toBe("Ordered");
    expect(o.orderedAt).toBe(t);
  });
  it("rejects invalid ordered transition", async () => {
    const x = ctx();
    const p = await purchase(x);
    await uc.markPurchaseOrderedUseCase(x.c as any).execute({ id: p.id });
    await expect(
      uc.markPurchaseOrderedUseCase(x.c as any).execute({ id: p.id }),
    ).rejects.toThrow("transition");
  });
  it("cancels draft", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc.cancelPurchaseUseCase(x.c as any).execute({ id: p.id }),
    ).resolves.toMatchObject({ status: "Cancelled" });
  });
  it("rejects cancelling received", async () => {
    const x = ctx();
    const p = await purchase(x);
    x.repos.purchases.update(p.id, { status: "Received", updatedAt: t });
    await expect(
      uc.cancelPurchaseUseCase(x.c as any).execute({ id: p.id }),
    ).rejects.toThrow("cannot be cancelled");
  });
  it("gets purchase", async () => {
    const x = ctx();
    const p = await purchase(x);
    expect(
      await uc.getPurchaseUseCase(x.c as any).execute({ id: p.id }),
    ).toMatchObject({ id: p.id });
  });
  it("lists purchases", async () => {
    const x = ctx();
    await purchase(x);
    expect((await uc.listPurchasesUseCase(x.c as any).execute({})).total).toBe(
      1,
    );
  });
  it("receives first receipt", async () => {
    const x = ctx();
    const p = await purchase(x);
    const r = await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 1 }],
      });
    expect(r.replayed).toBe(false);
    expect(x.moves).toHaveLength(1);
    expect(r.purchase.status).toBe("PartiallyReceived");
  });
  it("receives complete", async () => {
    const x = ctx();
    const p = await purchase(x);
    const r = await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 2 }],
      });
    expect(r.purchase.status).toBe("Received");
    expect(r.purchase.receivedAt).toBe(t);
  });
  it("replays receipt", async () => {
    const x = ctx();
    const p = await purchase(x);
    await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 1 }],
      });
    const r = await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 1 }],
      });
    expect(r.replayed).toBe(true);
    expect(x.moves).toHaveLength(1);
  });
  it("conflicts receipt replay", async () => {
    const x = ctx();
    const p = await purchase(x);
    await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 1 }],
      });
    await expect(
      uc
        .receivePurchaseUseCase(x.c as any)
        .execute({
          purchaseId: p.id,
          idempotencyKey: "k",
          lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 2 }],
        }),
    ).rejects.toThrow("conflict");
  });
  it("rejects over receipt", async () => {
    const x = ctx();
    const p = await purchase(x);
    await expect(
      uc
        .receivePurchaseUseCase(x.c as any)
        .execute({
          purchaseId: p.id,
          idempotencyKey: "k",
          lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 3 }],
        }),
    ).rejects.toThrow("quantity");
  });
  it("unlinked receipt has no stock movement", async () => {
    const x = ctx();
    const p = await uc
      .createPurchaseUseCase(x.c as any)
      .execute({
        lines: [{ titleSnapshot: "A", quantity: 1, unitPurchaseCost: 1 }],
      });
    await uc
      .receivePurchaseUseCase(x.c as any)
      .execute({
        purchaseId: p.id,
        idempotencyKey: "k",
        lines: [{ purchaseLineId: p.lines[0].id, quantityReceived: 1 }],
      });
    expect(x.moves).toHaveLength(0);
  });
});
