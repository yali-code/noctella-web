"use client";

import { useEffect, useState } from "react";
import { activateWarehouse, deactivateWarehouse, erpWarehouseApi, mapWarehouse } from "@/lib/erpWarehouseBridge";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

export default function WarehouseDetailPage({ params }: { params: { id: string } }) {
  const [warehouse, setWarehouse] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .warehouse(params.id)
      .then(setWarehouse)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load warehouse"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading warehouse...</p>;
  if (loadError && !warehouse) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!warehouse) return null;

  const w = mapWarehouse(warehouse);
  const blockedByOther = busyCount > 0;

  return (
    <main>
      <h1>{w.name}</h1>
      <p>Code {w.code} · Status {w.status}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>Country {warehouse.country_code ?? "—"} · City {warehouse.city ?? "—"} · ERP reference {warehouse.erp_reference_id ?? "—"}</p>
      <p>Created {warehouse.created_at} · Updated {warehouse.updated_at}</p>

      <section>
        <h2>Actions</h2>
        <ConfirmButton
          label="Activate"
          eligible={w.status !== "Active"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => activateWarehouse(warehouse.id).then(() => {})}
        />
        <ConfirmButton
          label="Deactivate"
          eligible={w.status === "Active"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => deactivateWarehouse(warehouse.id).then(() => {})}
        />
      </section>
    </main>
  );
}
