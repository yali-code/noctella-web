"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createWarehouse, erpWarehouseApi, mapWarehouse } from "@/lib/erpWarehouseBridge";

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

export default function WarehousesPage() {
  const router = useRouter();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .warehouses()
      .then((res) => setWarehouses(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load warehouses"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCreate() {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (!code.trim() || !name.trim()) throw new Error("Warehouse code and name are required");
      const created = await createWarehouse({ code: code.trim(), name: name.trim(), countryCode: countryCode.trim() || undefined });
      setFormOpen(false);
      setCode("");
      setName("");
      setCountryCode("");
      router.push(`/warehouses/${created.warehouseId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create warehouse");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Warehouses</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      <button style={buttonStyle} onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Cancel" : "Create Warehouse"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Warehouse</h2>
          <input style={inputStyle} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
          <input style={inputStyle} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={inputStyle} placeholder="Country code (optional)" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Creating…" : "Submit Warehouse"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading warehouses...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && warehouses.length === 0 && <p>No warehouses found.</p>}

      {!loading && !loadError && warehouses.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Code</th><th>Name</th><th>Status</th></tr>
          </thead>
          <tbody>
            {warehouses.map((row) => {
              const w = mapWarehouse(row);
              return (
                <tr key={w.id}>
                  <td>{w.code}</td>
                  <td>{w.name}</td>
                  <td>{w.status}</td>
                  <td><a href={w.href}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
