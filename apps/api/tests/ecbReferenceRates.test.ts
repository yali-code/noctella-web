import { describe, expect, it, vi } from "vitest";
import { buildEcbRateUrl, createEcbRateLookup, parseEcbCsv, pickRateOnOrBefore } from "../src/services/ecbReferenceRates";
import { FxRateUnavailableError } from "../src/services/errors";

/** PHASE-2C: ECB reference rates. fetch is always mocked; no network call is ever made. */
const CSV = [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS",
  "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-09-16,11.0215,A",
  "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-09-17,11.0480,A",
  "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-09-18,11.0625,A",
  "",
].join("\r\n");
const csvResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/csv" } });

describe("ECB reference rates (PHASE-2C)", () => {
  it("builds the Data Portal URL with a 10-day window ending on the paid date", () => {
    expect(buildEcbRateUrl("SEK", "2026-09-18")).toBe("https://data-api.ecb.europa.eu/service/data/EXR/D.SEK.EUR.SP00.A?startPeriod=2026-09-08&endPeriod=2026-09-18&format=csvdata");
    expect(buildEcbRateUrl("DKK", "2026-03-02")).toContain("startPeriod=2026-02-20&endPeriod=2026-03-02");
  });

  it("parses csvdata by header name and ignores malformed rows", () => {
    expect(parseEcbCsv(CSV)).toEqual([{ date: "2026-09-16", value: 11.0215 }, { date: "2026-09-17", value: 11.048 }, { date: "2026-09-18", value: 11.0625 }]);
    expect(parseEcbCsv("TIME_PERIOD,OBS_VALUE\n2026-09-18,NaN\nbad,1")).toEqual([]);
    expect(parseEcbCsv("<html>error</html>")).toBeNull();
    expect(parseEcbCsv("")).toBeNull();
  });

  it("takes the observation on the paid date when there is one", async () => {
    const fetchImpl = vi.fn(async () => csvResponse(CSV));
    const rate = await createEcbRateLookup(fetchImpl as any)("SEK", "2026-09-18");
    expect(rate).toEqual({ rate: 11.0625, rateDate: "2026-09-18", source: "ECB" });
    expect(fetchImpl).toHaveBeenCalledWith(buildEcbRateUrl("SEK", "2026-09-18"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("a weekend paid date uses the previous business day", async () => {
    // 2026-09-20 is a Sunday; the window still ends on it and the latest observation (Friday 18th) is used.
    const rate = await createEcbRateLookup((async () => csvResponse(CSV)) as any)("SEK", "2026-09-20");
    expect(rate).toEqual({ rate: 11.0625, rateDate: "2026-09-18", source: "ECB" });
    expect(pickRateOnOrBefore([{ date: "2026-09-21", value: 2 }, { date: "2026-09-18", value: 1 }], "2026-09-20")).toEqual({ date: "2026-09-18", value: 1 });
  });

  it("EUR needs no fetch and has rate 1", async () => {
    const fetchImpl = vi.fn();
    expect(await createEcbRateLookup(fetchImpl as any)("EUR", "2026-09-20")).toEqual({ rate: 1, rateDate: "2026-09-20", source: "EUR" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("any network error, timeout, HTTP error or empty result becomes the generic FxRateUnavailableError", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
      async () => csvResponse("Internal error", 500),
      async () => csvResponse("TIME_PERIOD,OBS_VALUE\n"),
      async () => csvResponse("TIME_PERIOD,OBS_VALUE\n2026-09-21,11.1\n"),
    ];
    for (const impl of cases) {
      const err = await createEcbRateLookup(impl as any)("SEK", "2026-09-20").catch((e) => e);
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect(err.message).toBe("The official exchange rate is not available right now. Try again later.");
    }
    await expect(createEcbRateLookup(vi.fn() as any)("S/K", "2026-09-20")).rejects.toBeInstanceOf(FxRateUnavailableError);
  });
});
