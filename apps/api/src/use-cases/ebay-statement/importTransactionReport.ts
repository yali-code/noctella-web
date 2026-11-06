import { createHash, randomUUID } from "node:crypto";
import { BadRequestError } from "../../services/errors";
import type { EbayStatementRepository, EbayStatementRowRecord } from "../../repositories/ebay-statement/types";
import { amount, blank, fundsStatus, headerValue, readEbayTransactionReport, type EbayReportRow } from "./previewTransactionReport";

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const EU_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
const STORED_TYPES = new Set(["Order", "Other fee", "Refund", "Payout"]);

function isoDate(value: string): string {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(value.trim());
  if (!match || !MONTHS[match[1]!]) throw new BadRequestError(`Unreadable date in the report: "${value}"`);
  return `${match[3]}-${MONTHS[match[1]!]}-${match[2]!.padStart(2, "0")}`;
}

/** The key is stable between downloads of the same month (verified on two September 2026 downloads). */
function rowKey(row: EbayReportRow): string {
  const reference = blank(row["Reference ID"]);
  if (row.Type === "Order") {
    if (!blank(row["Transaction ID"])) throw new BadRequestError(`Order ${row["Order number"]} has no transaction ID`);
    return `order:${row["Transaction ID"]}`;
  }
  if (row.Type === "Payout") {
    if (!blank(row["Payout ID"])) throw new BadRequestError("A payout row has no payout ID");
    return `payout:${row["Payout ID"]}`;
  }
  if (!reference) throw new BadRequestError(`A ${row.Type} row has no reference ID`);
  return row.Type === "Other fee" ? `fee:${reference}` : `refund:${row["Order number"]}:${reference}`;
}

/** Matches numeric(18,6) so a stored value compares equal on both databases and a repeat upload changes nothing. */
const stored = (value: number) => Math.round(value * 1e6) / 1e6 + 0;

function toRecord(row: EbayReportRow): EbayStatementRowRecord {
  const orderFees = amount(row["Final Value Fee - fixed"]) + amount(row["Final Value Fee - variable"]) + amount(row["International fee"]);
  const rate = stored(amount(row["Exchange rate"]));
  return {
    id: rowKey(row),
    rowType: row.Type,
    transactionDate: isoDate(row["Transaction creation date"]),
    orderNumber: blank(row["Order number"]),
    transactionId: blank(row["Transaction ID"]),
    referenceId: blank(row["Reference ID"]),
    itemId: blank(row["Item ID"]),
    title: blank(row["Item title"]),
    customLabel: blank(row["Custom label"]),
    shipCountry: blank(row["Ship to country"]),
    shipCity: blank(row["Ship to city"]),
    itemSubtotalUsd: stored(amount(row["Item subtotal"])),
    shippingUsd: stored(amount(row["Shipping and handling"])),
    ebayTaxUsd: stored(amount(row["eBay collected tax"])),
    feesUsd: stored(row.Type === "Other fee" ? -amount(row["Gross transaction amount"]) : row.Type === "Order" ? -orderFees : 0),
    grossUsd: stored(amount(row["Gross transaction amount"])),
    netEur: stored(amount(row["Net amount"])),
    exchangeRate: rate || null,
    fundsStatus: row.Type === "Order" ? fundsStatus(row) : null,
    payoutId: blank(row["Payout ID"]),
    payoutDate: blank(row["Payout date"]),
    description: blank(row.Description)?.trim() ?? null,
  };
}

const same = (a: EbayStatementRowRecord, b: EbayStatementRowRecord) =>
  (Object.keys(b) as Array<keyof EbayStatementRowRecord>).every((key) => (a[key] ?? null) === (b[key] ?? null));

/**
 * Stores the report idempotently: a new row is inserted, a changed row (usually payout state) is updated,
 * an identical one is left alone. Every step is safe to repeat, so a failed upload can simply be retried.
 * Stock is never touched here.
 */
export async function importEbayTransactionReportUseCase(repository: EbayStatementRepository, text: string, now = new Date().toISOString()) {
  const { all, rows } = readEbayTransactionReport(text);
  const records = new Map<string, EbayStatementRowRecord>();
  for (const row of rows.filter((candidate) => STORED_TYPES.has(candidate.Type))) {
    const record = toRecord(row);
    if (records.has(record.id)) throw new BadRequestError(`The report repeats the same row: ${record.id}`);
    records.set(record.id, record);
  }
  const existing = new Map((await repository.findRowsByIds([...records.keys()])).map((row) => [row.id, row]));
  let inserted = 0, updated = 0, unchanged = 0;
  for (const record of records.values()) {
    const current = existing.get(record.id);
    if (!current) { await repository.insertRow(record, now); inserted += 1; }
    else if (!same(current, record)) { await repository.updateRow(record, now); updated += 1; }
    else unchanged += 1;
  }
  await repository.insertImport({
    id: randomUUID(),
    fileSha256: createHash("sha256").update(text).digest("hex"),
    seller: headerValue(all, "Seller"),
    periodStart: headerValue(all, "Start date"),
    periodEnd: headerValue(all, "End date"),
    insertedCount: inserted,
    updatedCount: updated,
    unchangedCount: unchanged,
  }, now);
  return { inserted, updated, unchanged, skippedTypes: [...new Set(rows.filter((row) => !STORED_TYPES.has(row.Type)).map((row) => row.Type))] };
}

const money = (value: number) => Math.round(value * 100) / 100;

/** Monthly fee performance and the provisional EU VAT figure. Not accountant-approved. */
export async function listEbayStatementMonthsUseCase(repository: EbayStatementRepository) {
  const months = new Map<string, EbayStatementRowRecord[]>();
  for (const row of await repository.listRows()) {
    const month = row.transactionDate.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), row]);
  }
  return [...months.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, rows]) => {
    const orders = rows.filter((row) => row.rowType === "Order");
    const fees = rows.filter((row) => row.rowType === "Other fee");
    const sum = (items: EbayStatementRowRecord[], read: (row: EbayStatementRowRecord) => number) => money(items.reduce((total, row) => total + read(row), 0));
    const salesUsd = sum(orders, (row) => row.grossUsd);
    const totalFeesUsd = money(sum(orders, (row) => row.feesUsd) + sum(fees, (row) => row.feesUsd));
    const euOrders = orders.filter((row) => row.shipCountry && EU_COUNTRIES.has(row.shipCountry));
    const euSalesEur = sum(euOrders, (row) => row.grossUsd * (row.exchangeRate ?? 0));
    return {
      month,
      orderCount: orders.length,
      unmatchedOrderCount: orders.filter((row) => !row.customLabel).length,
      salesUsd,
      salesEur: sum(orders, (row) => row.grossUsd * (row.exchangeRate ?? 0)),
      shippingUsd: sum(orders, (row) => row.shippingUsd),
      ebayTaxUsd: sum(orders, (row) => row.ebayTaxUsd),
      orderFeesUsd: sum(orders, (row) => row.feesUsd),
      otherFeesUsd: sum(fees, (row) => row.feesUsd),
      totalFeesUsd,
      feeRatePercent: salesUsd > 0 ? Math.round((totalFeesUsd / salesUsd) * 1000) / 10 : 0,
      refundsNetEur: sum(rows.filter((row) => row.rowType === "Refund"), (row) => -row.netEur),
      netRemainingEur: sum(rows.filter((row) => row.rowType !== "Payout"), (row) => row.netEur),
      payoutsEur: sum(rows.filter((row) => row.rowType === "Payout"), (row) => -row.netEur),
      euSalesEur,
      provisionalEuVatEur: money((euSalesEur * 20) / 120),
    };
  });
}
