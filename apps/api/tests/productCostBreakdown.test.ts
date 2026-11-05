import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import { getProductCostBreakdownUseCase } from "../src/use-cases/invoice-intake/costSetUseCases";

describe("product cost breakdown", () => {
  it("returns goods, transport, FX difference and total from the stored allocation", async () => {
    const repository = {
      findApprovedCostSetItemByProduct: async () => ({
        costSet: { id: "set-1", title: "Lot 1", purchaseId: "purchase-1" },
        item: { allocLotEur: 10.46, allocHammerFeeEur: 0.71, allocPremiumEur: 2.09, allocTransportEur: 4.53, allocForwarderEur: 0, allocFxDiffEur: 0.59, allocTotalEur: 18.38 },
      }),
    } as any;
    expect(await getProductCostBreakdownUseCase({ repository }, "p1")).toEqual({
      currency: "EUR", costSetId: "set-1", costSetTitle: "Lot 1", purchaseId: "purchase-1", goodsEur: 13.26, transportEur: 4.53, fxDifferenceEur: 0.59, totalEur: 18.38,
    });
  });

  it("returns null without an approved cost set", async () => {
    const repository = { findApprovedCostSetItemByProduct: async () => null } as any;
    expect(await getProductCostBreakdownUseCase({ repository }, "p1")).toBeNull();
  });

  it("backfills only approved cost set products with a cost and no currency", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    sqlite.pragma("foreign_keys = OFF");
    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>);
    const insert = (table: string, values: Record<string, unknown>) => {
      const row = { ...values };
      for (const c of columns(table)) if (c.notnull && c.dflt_value == null && !(c.name in row)) row[c.name] = /INT|REAL/.test(c.type) ? 0 : c.name;
      const keys = Object.keys(row);
      sqlite.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k] as any));
    };
    const product = (id: string, cost: number | null, currency: string | null) => insert("products", { id, sku: id, slug: id, purchase_cost: cost, purchase_currency: currency });
    product("approved", 18.38, null);
    product("open", 5, null);
    product("usd", 7, "USD");
    insert("invoice_cost_sets", { id: "a", status: "approved" });
    insert("invoice_cost_sets", { id: "o", status: "open" });
    for (const [id, set, productId] of [["1", "a", "approved"], ["2", "o", "open"], ["3", "a", "usd"]]) insert("invoice_cost_set_items", { id, cost_set_id: set, product_id: productId });

    ensureSchema(sqlite);

    const currency = (id: string) => (sqlite.prepare("SELECT purchase_currency c FROM products WHERE id = ?").get(id) as { c: string | null }).c;
    expect(currency("approved")).toBe("EUR");
    expect(currency("open")).toBeNull();
    expect(currency("usd")).toBe("USD");
  });
});
