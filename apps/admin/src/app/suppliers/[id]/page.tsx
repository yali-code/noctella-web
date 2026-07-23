"use client";

import { useEffect, useState } from "react";
import { SupplierStatus, SupplierType } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import { buildPurchaseQuery, mapPurchase, mapSupplier, purchasingApi, updateSupplier } from "@/lib/erpPurchasingBridge";

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

export default function SupplierDetailPage({ params }: { params: { id: string } }) {
  const [supplier, setSupplier] = useState<any>(null);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string>(SupplierStatus.Active);
  const [supplierType, setSupplierType] = useState<string>(SupplierType.Other);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = useState(false);

  function load() {
    setLoading(true);
    setLoadError(null);
    purchasingApi
      .supplier(params.id)
      .then((s) => {
        setSupplier(s);
        setName(s.name);
        setStatus(s.status);
        setSupplierType(s.supplierType);
        purchasingApi.purchases(buildPurchaseQuery({ supplierId: params.id })).then((r) => setPurchases(r.items ?? [])).catch(() => setPurchases([]));
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load supplier"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  function openEdit() {
    setEditOpen(true);
    setUpdateError(null);
    setUpdateSuccess(false);
  }

  async function handleUpdate() {
    if (updateBusy || !supplier) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      if (!name.trim()) throw new Error("Supplier name is required");
      await updateSupplier(supplier.id, { name: name.trim(), status, supplierType }, supplier.updatedAt);
      setEditOpen(false);
      setUpdateSuccess(true);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setUpdateError("This supplier was changed by someone else since it was loaded. Reload to see the latest version before retrying.");
      } else {
        setUpdateError(err instanceof Error ? err.message : "Failed to update supplier");
      }
    } finally {
      setUpdateBusy(false);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading supplier...</p>;
  if (loadError && !supplier) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!supplier) return null;

  const s = mapSupplier(supplier);

  return (
    <main>
      <h1>{s.name}</h1>
      <p>Status {s.status} · Type {s.type} · Location {s.location || "—"} · ERP reference {s.erpReferenceId}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>Purchases {s.purchaseCount} · Last purchase {s.lastPurchase}</p>

      <section>
        <h2>Update Supplier</h2>
        {!editOpen ? (
          <button style={buttonStyle} onClick={openEdit}>Edit</button>
        ) : (
          <div style={{ marginTop: 6 }}>
            <input style={inputStyle} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <select style={inputStyle} value={supplierType} onChange={(e) => setSupplierType(e.target.value)}>
              {Object.values(SupplierType).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
              {Object.values(SupplierStatus).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <div style={{ marginTop: 6 }}>
              <button disabled={updateBusy} style={buttonStyle} onClick={handleUpdate}>{updateBusy ? "Saving…" : "Save"}</button>
              <button disabled={updateBusy} style={buttonStyle} onClick={() => setEditOpen(false)}>Cancel</button>
            </div>
          </div>
        )}
        {updateError && <p role="alert" style={{ color: "#c86a6a" }}>{updateError}</p>}
        {updateSuccess && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Supplier updated.</p>}
      </section>

      <section>
        <h2>Purchases from this supplier</h2>
        {purchases.length === 0 ? (
          <p>No purchases recorded for this supplier yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left" }}><th>Status</th><th>Source</th><th>References</th><th>Total</th></tr></thead>
            <tbody>
              {purchases.map((row) => {
                const p = mapPurchase(row);
                return (
                  <tr key={p.id}>
                    <td>{p.status}</td>
                    <td>{p.source}</td>
                    <td>{p.references}</td>
                    <td>{p.total}</td>
                    <td><a href={p.href}>View</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
