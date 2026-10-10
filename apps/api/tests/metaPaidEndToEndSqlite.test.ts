// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { MetaPaidCampaignClient } from "../src/integrations/ads/metaPaidCampaignClient";
import { collectPaidCampaignEvidence } from "../src/services/paidAdsCollection";
import { readPaidCampaignReport } from "../src/use-cases/ads/adsPaidCampaignRead";
import type { PaidCampaignQuery } from "../src/use-cases/ads/paidCampaignCollectorContract";

/**
 * ADS-006F end-to-end contract:
 * mock Meta HTTP -> real paid collector -> real SQLite analytics tables ->
 * the same paid-report projection consumed by authenticated Admin Marketing.
 *
 * This file never connects to a live provider, contacts Render, opens a real
 * ERP database, reads credentials or authorizes spend.
 */
const query: PaidCampaignQuery = {
  provider: "meta",
  accountId: "3095361257478763",
  campaignId: "987654321098765",
  startDate: "2026-10-01",
  endDate: "2026-10-02",
};
const fakeAccess = { accessToken: "fixture-secret-token-not-a-real-credential" };
const now = new Date("2026-10-09T15:00:00.000Z");

type Call = { url: URL; init: RequestInit };
function metaHttp(
  mode: "report" | "empty" | "wrong_campaign" | "wrong_currency" | "unauthorized" | "no_timezone" | "expired_token" = "report",
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const isInsights = url.pathname.endsWith("/insights");
    if (mode === "expired_token") {
      // Meta signals an expired/invalid token as HTTP 400 + OAuthException code 190.
      return new Response(JSON.stringify({
        error: { code: 190, message: "Untrusted secret data must never be logged" },
      }), { status: 400 });
    }
    if (mode === "unauthorized") {
      return new Response(JSON.stringify({
        error: { message: "Untrusted secret data must never be logged" },
      }), { status: 403 });
    }
    const responseBody = isInsights
      ? { data: mode === "empty" ? [] : [{
        campaign_id: mode === "wrong_campaign" ? "999999999999" : query.campaignId,
        date_start: query.startDate,
        date_stop: query.endDate,
        spend: "6.25",
        impressions: "700",
        clicks: "12",
      }] }
      : {
        account_id: query.accountId,
        currency: mode === "wrong_currency" ? "USD" : "EUR",
        ...(mode === "no_timezone" ? {} : { timezone_name: "Europe/Sofia" }),
      };
    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function paidSnapshots(db: ReturnType<typeof createTestDb>) {
  const rows = await db.all(sql`
    SELECT metric_key AS key, numeric_value AS value, value_state AS state
    FROM analytics_metric_snapshots WHERE scope_type='external_ad_campaign'
    ORDER BY metric_key
  `) as Array<{ key: string; value: number | null; state: string }>;
  return rows;
}

function assertGetOnly(calls: Call[]) {
  for (const { url, init } of calls) {
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.protocol).toBe("https:");
    expect(url.href).not.toContain(fakeAccess.accessToken);
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${fakeAccess.accessToken}`);
  }
}

describe("ADS-006F real SQLite + read-only Meta transport integration", () => {
  it("does not call Meta without explicit backend read approval", async () => {
    const db = createTestDb();
    const http = metaHttp();
    const client = new MetaPaidCampaignClient(http.fetchImpl);
    await expect(collectPaidCampaignEvidence(db, client, query, fakeAccess, {
      explicitReadApproval: false,
      explicitSnapshotWriteApproval: true,
    })).rejects.toThrow(/permission/);
    expect(http.calls).toHaveLength(0);
    expect(await paidSnapshots(db)).toHaveLength(0);
    expect((await readPaidCampaignReport(db, "meta", query.campaignId)).status)
      .toBe("NOT_COLLECTED");
  });

  it("preview reads valid EUR metrics but leaves SQLite empty and never approves spend", async () => {
    const db = createTestDb();
    const http = metaHttp();
    const result = await collectPaidCampaignEvidence(
      db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
        explicitReadApproval: true,
        explicitSnapshotWriteApproval: false,
        now,
      },
    );
    expect(result.status).toBe("PREVIEW_ONLY");
    expect(result.spendAuthorized).toBe(false);
    expect(result.evidence.spendEur).toBe(6.25);
    expect(JSON.stringify(result)).not.toContain(fakeAccess.accessToken);
    expect(await paidSnapshots(db)).toHaveLength(0);
    expect((await readPaidCampaignReport(db, "meta", query.campaignId)).status)
      .toBe("NOT_COLLECTED");
    expect(http.calls).toHaveLength(2);
    assertGetOnly(http.calls);
  });

  it("persists a verified campaign only when opted in, idempotently, for Admin read", async () => {
    const db = createTestDb();
    const http = metaHttp();
    const client = new MetaPaidCampaignClient(http.fetchImpl);
    const options = {
      explicitReadApproval: true,
      explicitSnapshotWriteApproval: true,
      now,
    };
    const first = await collectPaidCampaignEvidence(db, client, query, fakeAccess, options);
    expect(first.status).toBe("STORED");
    expect(first.spendAuthorized).toBe(false);
    expect(first.run?.status).toBe("completed");
    const snapshots = await paidSnapshots(db);
    expect(snapshots).toHaveLength(5);
    expect(snapshots.find(row => row.key === "paid_spend_eur")).toMatchObject({
      value: 6.25, state: "known",
    });
    expect(snapshots.find(row => row.key === "paid_provider_conversions")).toMatchObject({
      value: null, state: "unknown",
    });
    const replay = await collectPaidCampaignEvidence(db, client, query, fakeAccess, options);
    expect(replay.status).toBe("STORED");
    expect(replay.replayed).toBe(true);
    expect(await paidSnapshots(db)).toHaveLength(5);

    const report = await readPaidCampaignReport(db, "meta", query.campaignId);
    expect(report.status).toBe("REPORT_AVAILABLE");
    expect(report.evidence?.spendEur).toBe(6.25);
    expect(report.evidence?.impressions).toBe(700);
    expect(report.evidence?.clicks).toBe(12);
    expect(report.evidence?.reportedRoas).toBeNull();
    expect(report.evidence?.marketplaceConfirmedOrders).toBeNull();
    expect(report.evidence?.attributedMarketplaceRevenueEur).toBeNull();
    expect(report.marketplaceAttributionVerified).toBe(false);
    expect(report.spendAuthorized).toBe(false);
    expect(report.advice?.eligibleForAutomaticAction).toBe(false);
    expect(report.advice?.campaignPauseExecuted).toBe(false);
    expect(report.advice?.budgetChangeEur).toBeNull();
    expect((await readPaidCampaignReport(db, "google_ads", query.campaignId)).status)
      .toBe("NOT_COLLECTED");
    expect((await readPaidCampaignReport(db, "meta", "55555555555")).status)
      .toBe("NOT_COLLECTED");
    expect(http.calls).toHaveLength(4);
    assertGetOnly(http.calls);
    expect(JSON.stringify(report)).not.toContain(fakeAccess.accessToken);
  });

  it("keeps an empty Meta Insights response UNKNOWN and never stores synthetic zeros", async () => {
    const db = createTestDb();
    const http = metaHttp("empty");
    const client = new MetaPaidCampaignClient(http.fetchImpl);
    const preview = await collectPaidCampaignEvidence(db, client, query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: false, now,
    });
    expect(preview.status).toBe("PREVIEW_ONLY");
    expect(preview.evidence).toMatchObject({
      spendEur: null, impressions: null, clicks: null,
      warnings: ["NO_CAMPAIGN_REPORT"],
    });
    await expect(collectPaidCampaignEvidence(db, client, query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: true, now,
    })).rejects.toThrow(/No paid metrics supplied/);
    expect(await paidSnapshots(db)).toHaveLength(0);
    const report = await readPaidCampaignReport(db, "meta", query.campaignId);
    expect(report.status).toBe("NOT_COLLECTED");
    expect(report.evidence).toBeNull();
    expect(http.calls).toHaveLength(4);
    assertGetOnly(http.calls);
  });

  it("records the ad-account-local reporting window (Meta days are account-local, not UTC)", async () => {
    const db = createTestDb();
    const http = metaHttp();
    await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: true, now,
    });
    // Europe/Sofia is UTC+3 in October: local 2026-10-01 00:00 .. 2026-10-03 00:00.
    const report = await readPaidCampaignReport(db, "meta", query.campaignId);
    expect(report.status).toBe("REPORT_AVAILABLE");
    expect((report as { period?: unknown }).period).toEqual({ start: "2026-09-30T21:00:00.000Z", end: "2026-10-02T21:00:00.000Z" });
    const [meta] = await db.all(sql`SELECT metadata_json AS m FROM analytics_metric_snapshots LIMIT 1`) as Array<{ m: string }>;
    expect(JSON.parse(meta!.m)).toMatchObject({ reportingTimeZone: "Europe/Sofia", reportDates: { start: "2026-10-01", end: "2026-10-02" } });
  });

  it("refuses a window whose last account-local day has not ended yet", async () => {
    const db = createTestDb();
    const http = metaHttp();
    // The Sofia window ends at 2026-10-02T21:00Z; one hour earlier the account's last day is still open.
    // With one consistent clock the (stricter, east-of-UTC) UTC-day check rejects first; the
    // account-local-only path (west of UTC) is covered by the direct-store Los Angeles test.
    await expect(collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: true, now: new Date("2026-10-02T20:00:00.000Z"),
    })).rejects.toThrow(/must be complete|not ended in the provider account time zone/);
    expect(await paidSnapshots(db)).toHaveLength(0);
  });

  it("fails closed when the provider omits the account time zone", async () => {
    const db = createTestDb();
    const http = metaHttp("no_timezone");
    await expect(collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: true, now,
    })).rejects.toThrow(/time zone/);
    expect(http.calls).toHaveLength(1);
    expect(await paidSnapshots(db)).toHaveLength(0);
  });

  it("classifies an expired Meta token (HTTP 400, code 190) as authentication without leaking the body", async () => {
    const db = createTestDb();
    const http = metaHttp("expired_token");
    const error = await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
      explicitReadApproval: true, explicitSnapshotWriteApproval: false, now,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "PaidProviderReadError", kind: "authentication", message: "Paid provider returned HTTP 400" });
    expect(String((error as Error).message)).not.toContain("Untrusted secret");
  });

  it("never silently ignores a provider restatement of a stored window", async () => {
    const db = createTestDb();
    const options = { explicitReadApproval: true, explicitSnapshotWriteApproval: true, now };
    await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(metaHttp().fetchImpl), query, fakeAccess, options);
    const restated = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await metaHttp().fetchImpl(input, init);
      const body = await response.json() as Record<string, unknown>;
      if (Array.isArray(body.data)) (body.data[0] as Record<string, unknown>).spend = "7.10";
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(restated), query, fakeAccess, options))
      .rejects.toMatchObject({ name: "PaidEvidenceConflictError", code: "PAID_PROVIDER_RESTATEMENT" });
    const snapshots = await paidSnapshots(db);
    expect(snapshots).toHaveLength(5);
    expect(snapshots.find(row => row.key === "paid_spend_eur")?.value).toBe(6.25); // history preserved, not overwritten
  });

  it("refuses a second window ending at the same instant instead of recording a run without rows", async () => {
    const db = createTestDb();
    const options = { explicitReadApproval: true, explicitSnapshotWriteApproval: true, now };
    await collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(metaHttp().fetchImpl), query, fakeAccess, options);
    const shorter = { ...query, startDate: query.endDate };
    const oneDay = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await metaHttp().fetchImpl(input, init);
      const body = await response.json() as Record<string, unknown>;
      if (Array.isArray(body.data)) (body.data[0] as Record<string, unknown>).date_start = shorter.startDate;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(collectPaidCampaignEvidence(db, new MetaPaidCampaignClient(oneDay), shorter, fakeAccess, options))
      .rejects.toMatchObject({ code: "PAID_WINDOW_END_CONFLICT" });
    const runs = await db.all(sql`SELECT status, metric_count AS n FROM analytics_runs`) as Array<{ status: string; n: number }>;
    expect(runs).toEqual([{ status: "completed", n: 5 }]);
    expect(await paidSnapshots(db)).toHaveLength(5);
  });

  it("fails closed for mismatched identity, non-EUR, or permission errors", async () => {
    for (const mode of ["wrong_campaign", "wrong_currency", "unauthorized"] as const) {
      const db = createTestDb();
      const http = metaHttp(mode);
      await expect(collectPaidCampaignEvidence(
        db, new MetaPaidCampaignClient(http.fetchImpl), query, fakeAccess, {
          explicitReadApproval: true, explicitSnapshotWriteApproval: true, now,
        },
      )).rejects.toThrow();
      expect(await paidSnapshots(db)).toHaveLength(0);
      expect((await readPaidCampaignReport(db, "meta", query.campaignId)).status)
        .toBe("NOT_COLLECTED");
      expect(http.calls.length).toBe(mode === "wrong_currency" || mode === "unauthorized" ? 1 : 2);
      assertGetOnly(http.calls);
    }
  });
});
