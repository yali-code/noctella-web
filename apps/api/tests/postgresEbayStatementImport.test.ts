import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEbayStatementRepository } from "../src/repositories/ebay-statement/factory";
import { importEbayTransactionReportUseCase, listEbayStatementMonthsUseCase } from "../src/use-cases/ebay-statement/importTransactionReport";
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

const HEADER = ["Transaction creation date","Type","Order number","Ship to city","Ship to country","Net amount","Payout date","Payout ID","Reason for hold","Item ID","Transaction ID","Item title","Custom label","Quantity","Item subtotal","Shipping and handling","eBay collected tax","Final Value Fee - fixed","Final Value Fee - variable","International fee","Gross transaction amount","Transaction currency","Exchange rate","Reference ID","Description"];
const line = (values: Record<string, string>) => HEADER.map((h) => `"${values[h] ?? "--"}"`).join(",");
const report = (hold: string, payoutDate: string) => [HEADER.map((h) => `"${h}"`).join(","), line({ "Transaction creation date": "Oct 1, 2026", Type: "Order", "Order number": "26-1", "Ship to country": "ES", "Net amount": "32.21", "Payout date": payoutDate, "Reason for hold": hold, "Transaction ID": "T1", "Item subtotal": "39", "Shipping and handling": "4.99", "Final Value Fee - fixed": "-0.4", "Final Value Fee - variable": "-5.98", "Gross transaction amount": "43.99", "Exchange rate": "0.8563" })].join("\n");

describe.skipIf(!postgresTestConfigured)("eBay statement import on PostgreSQL", () => {
  let h: PostgresTestDb;
  beforeAll(async () => { h = await createPostgresTestDb(); });
  afterAll(async () => { await h?.close(); });

  it("stays idempotent with numeric columns and updates payout state", async () => {
    const repository = createEbayStatementRepository("postgres", h.db);
    expect(await importEbayTransactionReportUseCase(repository, report("Funds on hold.", "Nov 2, 2026"))).toMatchObject({ inserted: 1 });
    expect(await importEbayTransactionReportUseCase(repository, report("Funds on hold.", "Nov 2, 2026"))).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await importEbayTransactionReportUseCase(repository, report("--", "--"))).toMatchObject({ updated: 1 });
    const [month] = await listEbayStatementMonthsUseCase(repository);
    expect(month).toMatchObject({ month: "2026-10", orderCount: 1, salesUsd: 43.99, totalFeesUsd: 6.38, euSalesEur: 37.67 });
  });
});
