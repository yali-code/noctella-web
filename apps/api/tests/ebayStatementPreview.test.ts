import { describe, expect, it } from "vitest";
import { parseCsv, previewEbayTransactionReportUseCase } from "../src/use-cases/ebay-statement/previewTransactionReport";

const HEADER = ["Transaction creation date","Type","Order number","Legacy order ID","Buyer username","Buyer name","Ship to city","Ship to province/region/state","Ship to zip","Ship to country","Net amount","Payout currency","Payout date","Payout ID","Payout method","Payout status","Reason for hold","Item ID","Transaction ID","Item title","Custom label","Quantity","Item subtotal","Shipping and handling","Seller collected tax","eBay collected tax","Final Value Fee - fixed","Final Value Fee - variable","Regulatory operating fee","Very high \"\"item not as described\"\" fee","Below standard performance fee","International fee","Charity donation","Deposit processing fee","Gross transaction amount","Transaction currency","Exchange rate","Reference ID","Description"];
const blank = Object.fromEntries(HEADER.map((h) => [h, "--"]));
const line = (values: Record<string, string>) => HEADER.map((h) => `"${values[h] ?? blank[h]}"`).join(",");
const report = (...rows: string[]) => ['--,--', '"Seller","noctella"', '"Start date","Oct-01-2026"', '"End date","Oct-31-2026"', HEADER.map((h) => `"${h}"`).join(","), ...rows].join("\n");

const order = line({ "Transaction creation date": "Oct 1, 2026", Type: "Order", "Order number": "26-1", "Buyer username": "secretuser", "Buyer name": "Secret Buyer", "Ship to city": "Madrid", "Ship to zip": "28036", "Ship to country": "ES", "Net amount": "32.21", "Payout date": "Nov 2, 2026", "Transaction ID": "T1", "Item title": "Parker, 21 Pen", Quantity: "1", "Item subtotal": "39", "Shipping and handling": "4.99", "Final Value Fee - fixed": "-0.4", "Final Value Fee - variable": "-5.98", "Gross transaction amount": "43.99", "Exchange rate": "0.8563" });
const adFee = line({ "Transaction creation date": "Oct 1, 2026", Type: "Other fee", "Order number": "26-1", "Net amount": "-4.81", "Gross transaction amount": "-5.28", "Exchange rate": "1.0988", "Reference ID": "FEE-1", Description: "Promoted Listings - General fee " });
const storeFee = line({ "Transaction creation date": "Oct 2, 2026", Type: "Other fee", "Net amount": "-2.34", "Gross transaction amount": "-2.53", "Exchange rate": "1.08315", "Reference ID": "FEE-2", Description: "Promoted Stores Fee " });
const payout = line({ Type: "Payout", "Net amount": "-75", "Gross transaction amount": "-75", "Payout ID": "P1" });

describe("eBay Transaction report preview", () => {
  it("merges order and ad fee rows into the seller earnings eBay shows", () => {
    const preview = previewEbayTransactionReportUseCase(report(order, adFee, storeFee, payout));
    expect(preview.orders[0]).toMatchObject({ orderNumber: "26-1", title: "Parker, 21 Pen", salesUsd: 43.99, itemSubtotalUsd: 39, shippingUsd: 4.99, salesEur: 37.67, orderFeesUsd: 6.38, adFeesUsd: 5.28, adFeesEur: 4.81, orderNetEur: 32.21, earningsEur: 27.4, fundsStatus: "paid_out", customLabel: null, refundNetEur: 0, earningsAfterRefundEur: 27.4 });
    expect(preview.totals).toMatchObject({ salesUsd: 43.99, orderFeesUsd: 6.38, adFeesUsd: 5.28, monthlyFeesUsd: 2.53, totalFeesUsd: 14.19, payoutsEur: 75, netRemainingEur: 25.06 });
    expect(preview.monthlyFees).toHaveLength(1);
    expect(preview.rowCounts).toEqual({ Order: 1, "Other fee": 2, Payout: 1 });
  });

  it("never returns buyer identity or postal data", () => {
    const body = JSON.stringify(previewEbayTransactionReportUseCase(report(order)));
    for (const secret of ["secretuser", "Secret Buyer", "28036"]) expect(body).not.toContain(secret);
  });

  it("flags missing SKUs, unknown types, orphan refunds and net mismatches without blocking", () => {
    const refund = line({ Type: "Refund", "Order number": "11-9", "Net amount": "-35.01", "Gross transaction amount": "-50", "Reference ID": "Return ID 5" });
    const claim = line({ Type: "Claim", "Net amount": "-9" });
    const wrong = line({ Type: "Order", "Order number": "26-2", "Transaction ID": "T2", "Net amount": "1", "Gross transaction amount": "100", "Exchange rate": "0.8" });
    const preview = previewEbayTransactionReportUseCase(report(order, refund, claim, wrong));
    const warnings = preview.warnings.join("|");
    expect(warnings).toContain("Claim");
    expect(warnings).toContain("Refund for order 11-9");
    expect(warnings).toContain("Order 26-2");
    expect(warnings).toContain("2 of 2 orders have no Custom label");
    expect(preview.refunds[0]).toMatchObject({ grossUsd: 50, netEur: 35.01, parentOrderInFile: false });
    expect(preview.totals.netRemainingEur).toBe(-1.8);
  });

  it("rejects other files and changed formats", () => {
    expect(() => previewEbayTransactionReportUseCase("Date,Description\n1,2")).toThrow(/not an eBay Transaction report/);
    expect(() => previewEbayTransactionReportUseCase('"Transaction creation date","Type"\n"a","b"')).toThrow(/Missing columns/);
  });

  it("reads quoted commas and doubled quotes", () => {
    expect(parseCsv('a,"b,c","d""e"\n')).toEqual([["a", "b,c", 'd"e']]);
  });
});
