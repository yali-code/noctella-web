"use client";

import { useEffect, useState } from "react";
import { erpWarehouseApi, mapShipmentReady } from "@/lib/erpWarehouseBridge";

export default function ShipmentReadyPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .shipmentReady()
      .then((res) => setRows(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load the shipment-ready queue"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      <h1>Shipment Ready</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading the shipment-ready queue...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && <p>No orders are ready for shipment.</p>}

      {!loading && !loadError && rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Order</th><th>Customer</th><th>Packing status</th><th>Packages</th><th>Weight</th><th>Issues</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const q = mapShipmentReady(row);
              return (
                <tr key={q.orderId}>
                  <td>{q.orderNumber ?? q.orderId}</td>
                  <td>{q.customerMaskedSummary}</td>
                  <td>{q.packingStatus}</td>
                  <td>{q.packageCount}</td>
                  <td>{q.totalWeight ?? "—"}</td>
                  <td>{q.readinessIssues.length ? q.readinessIssues.join(", ") : "None"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
