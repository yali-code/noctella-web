"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SupplierType } from "@noctella/shared";
import { createSupplier, mapSupplier, purchasingApi } from "@/lib/erpPurchasingBridge";

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

export default function SuppliersPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [supplierType, setSupplierType] = useState<string>(SupplierType.Other);
  const [countryCode, setCountryCode] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    purchasingApi
      .suppliers()
      .then((res) => setSuppliers(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load suppliers"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCreate() {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (!name.trim()) throw new Error("Supplier name is required");
      const created = await createSupplier({ name: name.trim(), supplierType, countryCode: countryCode.trim() || undefined });
      setFormOpen(false);
      setName("");
      setSupplierType(SupplierType.Other);
      setCountryCode("");
      router.push(`/suppliers/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create supplier");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Suppliers</h1>
      <p>Supplier list shows status, type, country/city, ERP reference, purchase count, last purchase, and active/inactive state.</p>

      <button style={buttonStyle} onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Cancel" : "Create Supplier"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Supplier</h2>
          <input style={inputStyle} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select style={inputStyle} value={supplierType} onChange={(e) => setSupplierType(e.target.value)}>
            {Object.values(SupplierType).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input style={inputStyle} placeholder="Country code (optional)" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Creating…" : "Submit Supplier"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading suppliers...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && suppliers.length === 0 && <p>No suppliers found.</p>}

      {!loading && !loadError && suppliers.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Name</th><th>Status</th><th>Type</th><th>Location</th><th>ERP reference</th><th>Purchases</th><th>Last purchase</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((row) => {
              const s = mapSupplier(row);
              return (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.status}</td>
                  <td>{s.type}</td>
                  <td>{s.location || "—"}</td>
                  <td>{s.erpReferenceId}</td>
                  <td>{s.purchaseCount}</td>
                  <td>{s.lastPurchase}</td>
                  <td><a href={s.href}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
