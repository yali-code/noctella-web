"use client";

import { useEffect, useState } from "react";
import { erpWarehouseApi, mapWarehouseEvent } from "@/lib/erpWarehouseBridge";

export default function WarehouseEventsPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .events()
      .then((res) => setEvents(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load warehouse events"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      <h1>Warehouse Events</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading events...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && events.length === 0 && <p>No warehouse events found.</p>}

      {!loading && !loadError && events.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Type</th><th>Product</th><th>Order</th><th>Created</th></tr>
          </thead>
          <tbody>
            {events.map((row) => {
              const e = mapWarehouseEvent(row);
              return (
                <tr key={e.id}>
                  <td>{e.type}</td>
                  <td>{e.productId ?? "—"}</td>
                  <td>{e.orderId ?? "—"}</td>
                  <td>{e.createdAt}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
