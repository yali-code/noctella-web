"use client";

import { useEffect, useState } from "react";
import { cancelReservation, consumeReservation, erpWarehouseApi, mapReservation, releaseReservation } from "@/lib/erpWarehouseBridge";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

export default function ReservationDetailPage({ params }: { params: { id: string } }) {
  const [reservation, setReservation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .reservations()
      .then((res) => {
        const found = (res.items ?? []).find((row: any) => row.id === params.id);
        if (!found) throw new Error("Reservation not found");
        setReservation(found);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load reservation"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading reservation...</p>;
  if (loadError && !reservation) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!reservation) return null;

  const r = mapReservation(reservation);
  const blockedByOther = busyCount > 0;

  return (
    <main>
      <h1>Reservation {r.id}</h1>
      <p>Product {r.productId} · Order {r.orderId ?? "—"} · Quantity {r.quantity} · Status {r.status}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>Expires {r.expiresAt ?? "—"}</p>

      <section>
        <h2>Actions</h2>
        <ConfirmButton
          label="Release"
          eligible={r.canRelease}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => releaseReservation(r.id).then(() => {})}
        />
        <ConfirmButton
          label="Cancel Reservation"
          eligible={r.canCancel}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelReservation(r.id).then(() => {})}
        />
        <ConfirmButton
          label="Consume"
          eligible={r.status === "Active"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => consumeReservation(r.id).then(() => {})}
        />
      </section>
    </main>
  );
}
