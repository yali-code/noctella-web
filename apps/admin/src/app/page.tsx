import { ConstellationBackground } from "@/components/ConstellationBackground";
import { erpReportsApi, mapDashboard } from "@/lib/erpReportsAnalyticsBridge";
import { formatMetricValue, CompletenessWarnings, ReportError } from "@/components/reports/ReportSections";

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

  return (
    <div style={{ position: "relative" }}>
      <ConstellationBackground />
      <div style={{ position: "relative" }}>
        <h1>Dashboard</h1>
        <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
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
