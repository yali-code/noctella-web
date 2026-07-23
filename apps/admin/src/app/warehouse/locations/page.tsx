"use client";

import { useEffect, useState } from "react";
import { createLocation, erpWarehouseApi, mapLocation, mapWarehouse } from "@/lib/erpWarehouseBridge";

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

export default function WarehouseLocationsPage() {
  const [locations, setLocations] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [locationType, setLocationType] = useState("Bin");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState(false);

  function load() {
    setLoading(true);
    setLoadError(null);
    Promise.all([erpWarehouseApi.locations(), erpWarehouseApi.warehouses()])
      .then(([locRes, whRes]) => {
        setLocations(locRes.items ?? []);
        setWarehouses(whRes.items ?? []);
        setWarehouseId((prev) => prev || whRes.items?.[0]?.id || "");
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load locations"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const warehouseCode = (id?: string) => mapWarehouse(warehouses.find((w) => w.id === id) ?? {}).code ?? id;

  async function handleCreate() {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    setCreateSuccess(false);
    try {
      if (!warehouseId) throw new Error("Select a warehouse");
      if (!code.trim() || !name.trim()) throw new Error("Location code and name are required");
      await createLocation({ warehouseId, code: code.trim(), name: name.trim(), locationType });
      setCode("");
      setName("");
      setCreateSuccess(true);
      setFormOpen(false);
      load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create location");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Warehouse Locations</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      <button style={buttonStyle} onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Cancel" : "Create Location"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Location</h2>
          <select style={inputStyle} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{mapWarehouse(w).code} — {mapWarehouse(w).name}</option>
            ))}
          </select>
          <input style={inputStyle} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
          <input style={inputStyle} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select style={inputStyle} value={locationType} onChange={(e) => setLocationType(e.target.value)}>
            {["Bin", "Shelf", "Aisle", "Zone", "Dock"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Creating…" : "Submit Location"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}
      {createSuccess && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Location created.</p>}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading locations...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && locations.length === 0 && <p>No locations found.</p>}

      {!loading && !loadError && locations.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Warehouse</th><th>Code</th><th>Name</th><th>Type</th><th>Status</th></tr>
          </thead>
          <tbody>
            {locations.map((row) => {
              const l = mapLocation(row);
              return (
                <tr key={l.id}>
                  <td>{warehouseCode(l.warehouseId)}</td>
                  <td>{l.code}</td>
                  <td>{l.name}</td>
                  <td>{l.type}</td>
                  <td>{l.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
