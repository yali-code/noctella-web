import Link from "next/link";
import { ConstellationBackground } from "@/components/ConstellationBackground";
import { erpReportsApi, mapDashboard } from "@/lib/erpReportsAnalyticsBridge";
import { formatMetricValue, CompletenessWarnings, ReportError } from "@/components/reports/ReportSections";
import { api } from "@/lib/api";
import type { PaginatedResult, PendingPublishItem } from "@/lib/types";

export const dynamic = "force-dynamic";

interface DashboardCard {
  label: string;
  key: string;
  value: unknown;
}

/**
 * Sprint 55B: replaces the previous hardcoded "—" placeholders. Only cards
 * backed by a real field in the reports dashboard payload are shown - the
 * old "Live Visitors" / "Pending AI Drafts" / "Active AI Chats" / "Product
 * Performance Alerts" cards had no corresponding backend metric here and
 * were dropped rather than left fabricated (Live Visitors is a real but
 * unrelated capability, out of scope for the reports bridge this sprint).
 */
function buildCards(dashboard: ReturnType<typeof mapDashboard>): DashboardCard[] {
  return [
    { label: "Active Products", key: "activeProductCount", value: dashboard.inventory?.activeProductCount },
    { label: "Physical Stock Quantity", key: "physicalStockQuantity", value: dashboard.inventory?.physicalStockQuantity },
    { label: "Expected Inventory Value", key: "expectedInventoryValue", value: dashboard.inventory?.expectedInventoryValue },
    { label: "Orders (period)", key: "orderCount", value: dashboard.sales?.orderCount },
    { label: "Gross Revenue (period)", key: "grossRevenue", value: dashboard.sales?.grossRevenue },
    { label: "Active Reservations", key: "activeReservations", value: dashboard.warehouse?.activeReservations },
    { label: "Customers", key: "customerCount", value: dashboard.customers?.customerCount },
  ];
}

/**
 * Sprint 139: Pending Publish count - reuses the same GET /api/products/pending-publish
 * eligibility (Stock-Accepted Draft/Approved Products) the /ready-to-publish queue page itself
 * queries, rather than duplicating that join predicate inside the ERP reports/analytics bridge.
 * Was Sprint 136's status=approved-only count; the card and the queue must never disagree on
 * membership, so both now go through the identical backend read model. Deliberately isolated in
 * its own try/catch, independent of the ERP dashboard fetch below, so a failure in either does not
 * affect the other.
 */
async function loadPendingPublishCount(): Promise<{ count: number | null; error: string | null }> {
  try {
    const result = await api.get<PaginatedResult<PendingPublishItem>>("/api/products/pending-publish?pageSize=1");
    return { count: result.total, error: null };
  } catch (e) {
    return { count: null, error: e instanceof Error ? e.message : "Pending Publish count unavailable" };
  }
}

export default async function DashboardPage() {
  let cards: DashboardCard[] = [];
  let warnings: string[] = [];
  let error: string | null = null;
  try {
    const raw = await erpReportsApi.dashboard();
    const dashboard = mapDashboard(raw);
    cards = buildCards(dashboard);
    warnings = dashboard.warnings;
  } catch (e) {
    error = e instanceof Error ? e.message : "Dashboard request failed";
  }

  const { count: pendingPublishCount, error: pendingPublishError } = await loadPendingPublishCount();

  return (
    <div style={{ position: "relative" }}>
      <ConstellationBackground />
      <div style={{ position: "relative" }}>
        <h1>Dashboard</h1>
        <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

        {/* Sprint 136/139: rendered unconditionally, independent of the ERP report's own error state
            below - a Pending Publish count failure must not hide the rest of the Dashboard, and a
            reports-bridge failure must not hide this card. */}
        <div style={{ marginBottom: 20 }}>
          <Link
            href="/ready-to-publish"
            className="noctella-panel"
            style={{ display: "block", maxWidth: 220, padding: 20, textDecoration: "none", color: "inherit" }}
          >
            <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>Pending Publish</p>
            <p style={{ margin: "8px 0 0", fontSize: 28, fontFamily: "var(--font-display)" }}>
              {pendingPublishError ? "—" : pendingPublishCount}
            </p>
            {pendingPublishError && (
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "#c86a6a" }}>{pendingPublishError}</p>
            )}
          </Link>
        </div>

        {error ? (
          <ReportError message={error} />
        ) : (
          <>
            <CompletenessWarnings warnings={warnings} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {cards.map((card) => (
                <div key={card.label} className="noctella-panel" style={{ padding: 20 }}>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                    {card.label}
                  </p>
                  <p style={{ margin: "8px 0 0", fontSize: 28, fontFamily: "var(--font-display)" }}>
                    {formatMetricValue(card.key, card.value)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
