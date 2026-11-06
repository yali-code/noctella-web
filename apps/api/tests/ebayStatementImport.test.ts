import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createEbayStatementRepository } from "../src/repositories/ebay-statement/factory";
import { importEbayTransactionReportUseCase, listEbayStatementMonthsUseCase } from "../src/use-cases/ebay-statement/importTransactionReport";

const HEADER = ["Transaction creation date","Type","Order number","Legacy order ID","Buyer username","Buyer name","Ship to city","Ship to province/region/state","Ship to zip","Ship to country","Net amount","Payout currency","Payout date","Payout ID","Payout method","Payout status","Reason for hold","Item ID","Transaction ID","Item title","Custom label","Quantity","Item subtotal","Shipping and handling","Seller collected tax","eBay collected tax","Final Value Fee - fixed","Final Value Fee - variable","Regulatory operating fee","Very high \"\"item not as described\"\" fee","Below standard performance fee","International fee","Charity donation","Deposit processing fee","Gross transaction amount","Transaction currency","Exchange rate","Reference ID","Description"];
const line = (values: Record<string, string>) => HEADER.map((h) => `"${values[h] ?? "--"}"`).join(",");
const report = (...rows: string[]) => ['"Seller","noctella"', HEADER.map((h) => `"${h}"`).join(","), ...rows].join("\n");
const order = (extra: Record<string, string> = {}) => line({ "Transaction creation date": "Oct 1, 2026", Type: "Order", "Order number": "26-1", "Buyer name": "Secret Buyer", "Buyer username": "secretuser", "Ship to zip": "28036", "Ship to city": "Madrid", "Ship to country": "ES", "Net amount": "32.21", "Transaction ID": "T1", "Item title": "Pen", "Item subtotal": "39", "Shipping and handling": "4.99", "Final Value Fee - fixed": "-0.4", "Final Value Fee - variable": "-5.98", "Gross transaction amount": "43.99", "Exchange rate": "0.8563", "Reason for hold": "Funds on hold.", ...extra });
const fee = line({ "Transaction creation date": "Oct 1, 2026", Type: "Other fee", "Order number": "26-1", "Net amount": "-4.81", "Gross transaction amount": "-5.28", "Exchange rate": "1.0988", "Reference ID": "FEE-1", Description: "Promoted Listings " });
const usOrder = line({ "Transaction creation date": "Oct 2, 2026", Type: "Order", "Order number": "26-2", "Ship to country": "US", "Net amount": "80", "Transaction ID": "T2", "eBay collected tax": "8", "Gross transaction amount": "100", "Exchange rate": "0.8", "Final Value Fee - variable": "-0" });
const refund = line({ "Transaction creation date": "Oct 3, 2026", Type: "Refund", "Order number": "26-1", "Net amount": "-10", "Gross transaction amount": "-12", "Reference ID": "Return ID 5" });
const payout = line({ "Transaction creation date": "Oct 4, 2026", Type: "Payout", "Net amount": "-50", "Payout ID": "P1", "Reference ID": "Bank reference ID X" });
const claim = line({ "Transaction creation date": "Oct 4, 2026", Type: "Claim", "Net amount": "-9" });

function repo() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  return { sqlite, repository: createEbayStatementRepository("sqlite", drizzle(sqlite, { schema })) };
}

describe("eBay statement import", () => {
  it("stores rows without buyer identity and never duplicates a repeated upload", async () => {
    const { sqlite, repository } = repo();
    const text = report(order(), fee, usOrder, refund, payout, claim);
    expect(await importEbayTransactionReportUseCase(repository, text)).toEqual({ inserted: 5, updated: 0, unchanged: 0, skippedTypes: ["Claim"] });
    expect(await importEbayTransactionReportUseCase(repository, text)).toEqual({ inserted: 0, updated: 0, unchanged: 5, skippedTypes: ["Claim"] });
    expect(sqlite.prepare("SELECT count(*) c FROM ebay_statement_rows").get()).toEqual({ c: 5 });
    const stored = JSON.stringify(sqlite.prepare("SELECT * FROM ebay_statement_rows").all());
    for (const secret of ["Secret Buyer", "secretuser", "28036"]) expect(stored).not.toContain(secret);
  });

  it("updates payout state from a later download of the same month", async () => {
    const { sqlite, repository } = repo();
    await importEbayTransactionReportUseCase(repository, report(order()));
    expect(await importEbayTransactionReportUseCase(repository, report(order({ "Reason for hold": "--", "Payout date": "Nov 2, 2026", "Payout ID": "P9" })))).toMatchObject({ inserted: 0, updated: 1 });
    expect(sqlite.prepare("SELECT funds_status s, payout_id p FROM ebay_statement_rows").get()).toEqual({ s: "paid_out", p: "P9" });
  });

  it("does not touch products or stock", async () => {
    const { sqlite, repository } = repo();
    const stock = () => sqlite.prepare("SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM orders) o").get();
    const before = stock();
    await importEbayTransactionReportUseCase(repository, report(order({ "Custom label": "NOC-000001" })));
    expect(stock()).toEqual(before);
  });

  it("reports monthly fee performance and provisional EU VAT only on EU sales", async () => {
    const { repository } = repo();
    await importEbayTransactionReportUseCase(repository, report(order(), fee, usOrder, refund, payout));
    const [month] = await listEbayStatementMonthsUseCase(repository);
    expect(month).toMatchObject({ month: "2026-10", orderCount: 2, unmatchedOrderCount: 2, salesUsd: 143.99, salesEur: 117.67, ebayTaxUsd: 8, orderFeesUsd: 6.38, otherFeesUsd: 5.28, totalFeesUsd: 11.66, feeRatePercent: 8.1, refundsNetEur: 10, netRemainingEur: 97.4, payoutsEur: 50, euSalesEur: 37.67, provisionalEuVatEur: 6.28 });
  });
});
