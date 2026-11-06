import { BadRequestError } from "../../services/errors";

/**
 * Reads an eBay Transaction report for review. Pure and read-only: nothing is stored and stock is untouched.
 * Buyer names, usernames, street-level data and postal codes never leave this function.
 */
const REQUIRED_COLUMNS = [
  "Transaction creation date", "Type", "Order number", "Ship to city", "Ship to country", "Net amount", "Payout date", "Payout ID",
  "Reason for hold", "Item ID", "Transaction ID", "Item title", "Custom label", "Quantity", "Item subtotal", "Shipping and handling",
  "eBay collected tax", "Final Value Fee - fixed", "Final Value Fee - variable", "International fee", "Gross transaction amount",
  "Transaction currency", "Exchange rate", "Reference ID", "Description",
] as const;
const KNOWN_TYPES = new Set(["Order", "Other fee", "Refund", "Payout"]);
const NET_CHECK_TOLERANCE_CENTS = 1;

type Row = Record<(typeof REQUIRED_COLUMNS)[number], string>;

export type EbayFundsStatus = "paid_out" | "on_hold" | "awaiting_payout";

export interface EbayStatementOrder {
  orderNumber: string;
  transactionId: string;
  date: string;
  title: string;
  customLabel: string | null;
  quantity: number;
  shipToCountry: string | null;
  shipToCity: string | null;
  itemSubtotalUsd: number;
  shippingUsd: number;
  salesUsd: number;
  salesEur: number;
  ebayCollectedTaxUsd: number;
  orderFeesUsd: number;
  adFeesUsd: number;
  adFeesEur: number;
  orderNetEur: number;
  earningsEur: number;
  exchangeRate: number;
  fundsStatus: EbayFundsStatus;
}

export interface EbayStatementPreview {
  seller: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rowCounts: Record<string, number>;
  orders: EbayStatementOrder[];
  monthlyFees: Array<{ date: string; description: string; referenceId: string; usd: number; eur: number }>;
  refunds: Array<{ date: string; orderNumber: string; title: string; returnId: string | null; grossUsd: number; netEur: number; parentOrderInFile: boolean }>;
  totals: {
    salesUsd: number; salesEur: number; itemSubtotalUsd: number; shippingUsd: number; ebayCollectedTaxUsd: number;
    orderFeesUsd: number; adFeesUsd: number; monthlyFeesUsd: number; totalFeesUsd: number; feeRatePercent: number;
    refundsNetEur: number; netRemainingEur: number; payoutsEur: number;
  };
  warnings: string[];
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

const cents = (value: number) => Math.round(value * 100);
const money = (value: number) => cents(value) / 100;
const blank = (value: string | undefined) => !value || value === "--" ? null : value;
function amount(value: string): number {
  if (blank(value) === null) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) throw new BadRequestError(`Unreadable amount in the report: "${value}"`);
  return parsed;
}
function headerValue(rows: string[][], label: string): string | null {
  return rows.find((row) => row[0] === label)?.[1]?.trim() || null;
}

function fundsStatus(row: Row): EbayFundsStatus {
  if (blank(row["Payout date"])) return "paid_out";
  return /hold/i.test(row["Reason for hold"]) ? "on_hold" : "awaiting_payout";
}

export function previewEbayTransactionReportUseCase(text: string): EbayStatementPreview {
  const all = parseCsv(text.replace(/^﻿/, ""));
  const headerIndex = all.findIndex((row) => row[0] === "Transaction creation date");
  if (headerIndex < 0) throw new BadRequestError("This is not an eBay Transaction report");
  const header = all[headerIndex]!;
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) throw new BadRequestError(`The report format changed. Missing columns: ${missing.join(", ")}`);

  const warnings: string[] = [];
  const rows = all.slice(headerIndex + 1).filter((row) => row.some((cell) => cell.trim())).map((cells, index) => {
    if (cells.length !== header.length) throw new BadRequestError(`Report line ${headerIndex + index + 2} has an unexpected number of columns`);
    return Object.fromEntries(header.map((name, i) => [name, cells[i]])) as Row;
  });

  const rowCounts: Record<string, number> = {};
  for (const row of rows) rowCounts[row.Type] = (rowCounts[row.Type] ?? 0) + 1;
  const unknownTypes = Object.keys(rowCounts).filter((type) => !KNOWN_TYPES.has(type));
  if (unknownTypes.length) warnings.push(`Row types not included in the totals: ${unknownTypes.join(", ")}`);

  const orderRows = rows.filter((row) => row.Type === "Order");
  const feeRows = rows.filter((row) => row.Type === "Other fee");
  const orderCounts = new Map<string, number>();
  for (const row of orderRows) orderCounts.set(row["Order number"], (orderCounts.get(row["Order number"]) ?? 0) + 1);
  const repeated = [...orderCounts].filter(([, count]) => count > 1).map(([order]) => order);
  if (repeated.length) warnings.push(`Orders with more than one line; ad fees are shown on the first line: ${repeated.join(", ")}`);
  const seenTransactions = new Set<string>();

  const adFeesByOrder = new Map<string, { usd: number; eur: number }>();
  for (const row of feeRows) {
    const order = blank(row["Order number"]);
    if (!order) continue;
    const current = adFeesByOrder.get(order) ?? { usd: 0, eur: 0 };
    adFeesByOrder.set(order, { usd: current.usd - amount(row["Gross transaction amount"]), eur: current.eur - amount(row["Net amount"]) });
  }

  const shownAdFees = new Set<string>();
  const orders = orderRows.map((row): EbayStatementOrder => {
    const orderNumber = row["Order number"];
    const salesUsd = amount(row["Gross transaction amount"]);
    const rate = amount(row["Exchange rate"]);
    const orderFeesUsd = -(amount(row["Final Value Fee - fixed"]) + amount(row["Final Value Fee - variable"]) + amount(row["International fee"]));
    const orderNetEur = amount(row["Net amount"]);
    if (Math.abs(cents((salesUsd - orderFeesUsd) * rate) - cents(orderNetEur)) > NET_CHECK_TOLERANCE_CENTS) warnings.push(`Order ${orderNumber}: net amount does not match sales less fees`);
    if (seenTransactions.has(row["Transaction ID"])) warnings.push(`Duplicate transaction ID: ${row["Transaction ID"]}`);
    seenTransactions.add(row["Transaction ID"]);
    const ads = shownAdFees.has(orderNumber) ? { usd: 0, eur: 0 } : adFeesByOrder.get(orderNumber) ?? { usd: 0, eur: 0 };
    shownAdFees.add(orderNumber);
    return {
      orderNumber,
      transactionId: row["Transaction ID"],
      date: row["Transaction creation date"],
      title: row["Item title"],
      customLabel: blank(row["Custom label"]),
      quantity: amount(row.Quantity),
      shipToCountry: blank(row["Ship to country"]),
      shipToCity: blank(row["Ship to city"]),
      itemSubtotalUsd: amount(row["Item subtotal"]),
      shippingUsd: amount(row["Shipping and handling"]),
      salesUsd,
      salesEur: money(salesUsd * rate),
      ebayCollectedTaxUsd: amount(row["eBay collected tax"]),
      orderFeesUsd: money(orderFeesUsd),
      adFeesUsd: money(ads.usd),
      adFeesEur: money(ads.eur),
      orderNetEur,
      earningsEur: money(orderNetEur - ads.eur),
      exchangeRate: rate,
      fundsStatus: fundsStatus(row),
    };
  });

  const orderNumbers = new Set(orderRows.map((row) => row["Order number"]));
  const orphanFees = [...adFeesByOrder.keys()].filter((order) => !orderNumbers.has(order));
  if (orphanFees.length) warnings.push(`Fees for orders outside this report: ${orphanFees.join(", ")}`);

  const monthlyFees = feeRows.filter((row) => !blank(row["Order number"])).map((row) => ({
    date: row["Transaction creation date"],
    description: row.Description.trim(),
    referenceId: row["Reference ID"],
    usd: money(-amount(row["Gross transaction amount"])),
    eur: money(-amount(row["Net amount"])),
  }));
  const refunds = rows.filter((row) => row.Type === "Refund").map((row) => ({
    date: row["Transaction creation date"],
    orderNumber: row["Order number"],
    title: row["Item title"],
    returnId: blank(row["Reference ID"]),
    grossUsd: money(-amount(row["Gross transaction amount"])),
    netEur: money(-amount(row["Net amount"])),
    parentOrderInFile: orderNumbers.has(row["Order number"]),
  }));
  for (const refund of refunds) if (!refund.parentOrderInFile) warnings.push(`Refund for order ${refund.orderNumber}: the order is not in this report`);
  const unmatched = orders.filter((order) => !order.customLabel).length;
  if (unmatched) warnings.push(`${unmatched} of ${orders.length} orders have no Custom label (SKU)`);

  const sum = <T>(items: T[], read: (item: T) => number) => money(items.reduce((total, item) => total + read(item), 0));
  const salesUsd = sum(orders, (o) => o.salesUsd);
  const orderFeesUsd = sum(orders, (o) => o.orderFeesUsd);
  const adFeesUsd = sum(orders, (o) => o.adFeesUsd);
  const monthlyFeesUsd = sum(monthlyFees, (f) => f.usd);
  const totalFeesUsd = money(orderFeesUsd + adFeesUsd + monthlyFeesUsd);
  return {
    seller: headerValue(all, "Seller"),
    periodStart: headerValue(all, "Start date"),
    periodEnd: headerValue(all, "End date"),
    rowCounts,
    orders,
    monthlyFees,
    refunds,
    totals: {
      salesUsd,
      salesEur: sum(orderRows, (row) => amount(row["Gross transaction amount"]) * amount(row["Exchange rate"])),
      itemSubtotalUsd: sum(orders, (o) => o.itemSubtotalUsd),
      shippingUsd: sum(orders, (o) => o.shippingUsd),
      ebayCollectedTaxUsd: sum(orders, (o) => o.ebayCollectedTaxUsd),
      orderFeesUsd,
      adFeesUsd,
      monthlyFeesUsd,
      totalFeesUsd,
      feeRatePercent: salesUsd > 0 ? Math.round((totalFeesUsd / salesUsd) * 1000) / 10 : 0,
      refundsNetEur: sum(refunds, (r) => r.netEur),
      netRemainingEur: sum(rows.filter((row) => KNOWN_TYPES.has(row.Type) && row.Type !== "Payout"), (row) => amount(row["Net amount"])),
      payoutsEur: sum(rows.filter((row) => row.Type === "Payout"), (row) => -amount(row["Net amount"])),
    },
    warnings,
  };
}
