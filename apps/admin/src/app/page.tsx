import { ConstellationBackground } from "@/components/ConstellationBackground";

interface DashboardCard {
  label: string;
  value: string;
}

const dashboardCards: DashboardCard[] = [
  { label: "Live Visitors", value: "—" },
  { label: "Today's Sales", value: "—" },
  { label: "Pending Orders", value: "—" },
  { label: "Pending Offers", value: "—" },
  { label: "Pending AI Drafts", value: "—" },
  { label: "Active AI Chats", value: "—" },
  { label: "Product Performance Alerts", value: "—" },
];

export default function DashboardPage() {
  return (
    <div style={{ position: "relative" }}>
      <ConstellationBackground />
      <div style={{ position: "relative" }}>
        <h1>Dashboard</h1>
        <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {dashboardCards.map((card) => (
            <div key={card.label} className="noctella-panel" style={{ padding: 20 }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                {card.label}
              </p>
              <p style={{ margin: "8px 0 0", fontSize: 28, fontFamily: "var(--font-display)" }}>
                {card.value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
