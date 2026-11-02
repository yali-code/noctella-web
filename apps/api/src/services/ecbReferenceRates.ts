import { FxRateUnavailableError } from "./errors";

/**
 * PHASE-2C: official FX reference rates from the ECB Data Portal (no key, no env). A rate is "1 EUR = X CUR".
 * The latest observation on or before the paid date is used, so a weekend or TARGET holiday falls back to the
 * previous business day. Any network, HTTP or parse failure becomes the generic FxRateUnavailableError; the
 * response body is never logged or surfaced.
 */
export interface FxReferenceRate { rate: number; rateDate: string; source: "ECB" | "EUR" }
export type FxRateLookup = (currency: string, paidDate: string) => Promise<FxReferenceRate>;

export const ECB_DATA_API_BASE = "https://data-api.ecb.europa.eu/service/data/EXR";
const LOOKBACK_DAYS = 10;
const TIMEOUT_MS = 15_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function minusDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function buildEcbRateUrl(currency: string, paidDate: string): string {
  return `${ECB_DATA_API_BASE}/D.${currency}.EUR.SP00.A?startPeriod=${minusDays(paidDate, LOOKBACK_DAYS)}&endPeriod=${paidDate}&format=csvdata`;
}

/** Parses the csvdata format by its header names (TIME_PERIOD, OBS_VALUE). Returns null when nothing usable is found. */
export function parseEcbCsv(csv: string): Array<{ date: string; value: number }> | null {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.trim());
  const dateIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  if (dateIdx < 0 || valueIdx < 0) return null;
  const out: Array<{ date: string; value: number }> = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const date = cols[dateIdx]?.trim();
    const value = Number(cols[valueIdx]);
    if (date && ISO_DATE.test(date) && Number.isFinite(value) && value > 0) out.push({ date, value });
  }
  return out;
}

/** The latest observation on or before paidDate; null when there is none. */
export function pickRateOnOrBefore(observations: Array<{ date: string; value: number }>, paidDate: string): { date: string; value: number } | null {
  let best: { date: string; value: number } | null = null;
  for (const o of observations) if (o.date <= paidDate && (!best || o.date > best.date)) best = o;
  return best;
}

export function createEcbRateLookup(fetchImpl?: typeof fetch): FxRateLookup {
  return async (currency, paidDate) => {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const cur = String(currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur) || !ISO_DATE.test(paidDate)) throw new FxRateUnavailableError();
    if (cur === "EUR") return { rate: 1, rateDate: paidDate, source: "EUR" };
    let text: string;
    try {
      const res = await doFetch(buildEcbRateUrl(cur, paidDate), { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error("ECB request failed");
      text = await res.text();
    } catch {
      throw new FxRateUnavailableError();
    }
    const picked = pickRateOnOrBefore(parseEcbCsv(text) ?? [], paidDate);
    if (!picked) throw new FxRateUnavailableError();
    return { rate: picked.value, rateDate: picked.date, source: "ECB" };
  };
}

export const ecbRateLookup: FxRateLookup = createEcbRateLookup();
