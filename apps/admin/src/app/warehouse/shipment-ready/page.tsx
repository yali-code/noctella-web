"use client";

import { useEffect, useState } from "react";
import { erpWarehouseApi, mapShipmentReady } from "@/lib/erpWarehouseBridge";
import { createShipment } from "@/lib/shipments";

export default function ShipmentReadyPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [carrierByOrder, setCarrierByOrder] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .shipmentReady()
      .then((res) => setRows(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load the shipment-ready queue"))
      .finally(() => setLoading(false));
  }, []);

  async function createReadyShipment(row: any) {
    const q = mapShipmentReady(row);
    setBusyOrderId(q.orderId);
    setLoadError(null);
    try {
      await createShipment(q.orderId, { packingTaskId: q.packingTaskId, carrierCode: carrierByOrder[q.orderId] });
      setRows((current) => current.filter((candidate) => mapShipmentReady(candidate).orderId !== q.orderId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to create shipment");
    } finally {
      setBusyOrderId(null);
    }
  }

  return (
    <main>
      <h1>Shipment Ready</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading the shipment-ready queue...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && <p>No orders are ready for shipment.</p>}

      {!loading && rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Order</th><th>Customer</th><th>Packing status</th><th>Packages</th><th>Weight</th><th>Issues</th><th>Action</th></tr>
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
                  <td><select aria-label={`Carrier for ${q.orderNumber ?? q.orderId}`} value={carrierByOrder[q.orderId] ?? ""} onChange={(event) => setCarrierByOrder((current) => ({ ...current, [q.orderId]: event.target.value }))}><option value="">Select carrier</option><option value="a1post">A1Post</option><option value="ups">UPS</option><option value="dhl">DHL</option><option value="fedex">FedEx</option><option value="dpd">DPD</option><option value="gls">GLS</option><option value="postnord">PostNord</option><option value="local_pickup">Local pickup</option></select> <button disabled={busyOrderId !== null || Boolean(q.shipmentId) || !carrierByOrder[q.orderId]} onClick={() => createReadyShipment(row)}>{busyOrderId === q.orderId ? "Creating…" : "Create Shipment"}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
