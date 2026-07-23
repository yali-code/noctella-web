"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createReservation, erpWarehouseApi, mapReservation } from "@/lib/erpWarehouseBridge";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export default function ReservationsPage() {
  const router = useRouter();
  const [reservations, setReservations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState<string | null>(null);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reservationReference, setReservationReference] = useState("");
  const [reason, setReason] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .reservations()
      .then((res) => setReservations(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load reservations"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openForm() {
    setFormOpen(true);
    setFormKey(crypto.randomUUID());
    setCreateError(null);
  }
  function closeForm() {
    setFormOpen(false);
    setFormKey(null);
  }

  async function handleCreate() {
    if (createBusy || !formKey) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const qty = Number(quantity);
      if (!productId.trim()) throw new Error("Product ID is required");
      if (!Number.isInteger(qty) || qty <= 0) throw new Error("Quantity must be a positive whole number");
      if (!reservationReference.trim()) throw new Error("Reservation reference is required");
      if (!reason.trim()) throw new Error("Reason is required");
      // Backend enforces the actual availability ceiling atomically; this is usability-only.
      const created = await createReservation({ idempotencyKey: formKey, productId: productId.trim(), quantity: qty, reservationReference: reservationReference.trim(), reason: reason.trim() });
      closeForm();
      setProductId("");
      setQuantity("1");
      setReservationReference("");
      setReason("");
      router.push(`/reservations/${created.reservationId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create reservation");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Reservations</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      <button style={buttonStyle} onClick={() => (formOpen ? closeForm() : openForm())}>{formOpen ? "Cancel" : "Create Reservation"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Reservation</h2>
          <input style={inputStyle} placeholder="Product ID" value={productId} onChange={(e) => setProductId(e.target.value)} />
          <input style={inputStyle} type="number" min={1} placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <input style={inputStyle} placeholder="Reservation reference" value={reservationReference} onChange={(e) => setReservationReference(e.target.value)} />
          <input style={inputStyle} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Submitting…" : "Submit Reservation"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading reservations...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && reservations.length === 0 && <p>No reservations found.</p>}

      {!loading && !loadError && reservations.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Product</th><th>Order</th><th>Quantity</th><th>Status</th><th>Expires</th></tr>
          </thead>
          <tbody>
            {reservations.map((row) => {
              const r = mapReservation(row);
              return (
                <tr key={r.id}>
                  <td>{r.productId}</td>
                  <td>{r.orderId ?? "—"}</td>
                  <td>{r.quantity}</td>
                  <td>{r.status}</td>
                  <td>{r.expiresAt ?? "—"}</td>
                  <td><a href={`/reservations/${r.id}`}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
