"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PurchaseSourceType, PurchaseStatus } from "@noctella/shared";
import {
  buildPurchaseHeaderPayload,
  buildPurchaseQuery,
  createPurchase,
  emptyPurchaseHeaderDraft,
  mapPurchase,
  purchaseHeaderFields,
  purchasingApi,
  type PurchaseHeaderDraft,
} from "@/lib/erpPurchasingBridge";

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

type LineDraft = { titleSnapshot: string; quantity: string; unitPurchaseCost: string; productId: string; sourceLineReference: string; weight: string };
const emptyLine = (): LineDraft => ({ titleSnapshot: "", quantity: "1", unitPurchaseCost: "0", productId: "", sourceLineReference: "", weight: "" });

export default function PurchasesPage() {
  const router = useRouter();
  const [purchases, setPurchases] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [sourceType, setSourceType] = useState<string>(PurchaseSourceType.Other);
  const [header, setHeader] = useState<PurchaseHeaderDraft>(emptyPurchaseHeaderDraft());
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    Promise.all([purchasingApi.purchases(buildPurchaseQuery({ status: status || undefined })), purchasingApi.suppliers()])
      .then(([purchaseRes, supplierRes]) => {
        setPurchases(purchaseRes.items ?? []);
        setSuppliers(supplierRes.items ?? []);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load purchases"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [status]);

  const supplierName = (id?: string | null) => suppliers.find((s) => s.id === id)?.name ?? (id ? id : "—");

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function handleCreate() {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const headerPayload = buildPurchaseHeaderPayload(header);
      const payloadLines = lines.map((l) => {
        const quantity = Number(l.quantity);
        const unitPurchaseCost = Number(l.unitPurchaseCost);
        if (!l.titleSnapshot.trim()) throw new Error("Every line needs a title");
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Quantity must be a positive whole number");
        if (Number.isNaN(unitPurchaseCost) || unitPurchaseCost < 0) throw new Error("Unit cost cannot be negative");
        const line: Record<string, unknown> = { titleSnapshot: l.titleSnapshot.trim(), quantity, unitPurchaseCost, productId: l.productId.trim() || undefined };
        if (l.sourceLineReference.trim()) line.sourceLineReference = l.sourceLineReference.trim();
        if (l.weight.trim()) {
          const weight = Number(l.weight);
          if (Number.isNaN(weight) || weight < 0) throw new Error("Weight cannot be negative");
          line.weight = weight;
        }
        return line;
      });
      const created = await createPurchase({ supplierId: supplierId || undefined, sourceType, ...headerPayload, lines: payloadLines });
      setFormOpen(false);
      setSupplierId("");
      setSourceType(PurchaseSourceType.Other);
      setHeader(emptyPurchaseHeaderDraft());
      setLines([emptyLine()]);
      router.push(`/purchases/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create purchase");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Purchases</h1>
      <p>Purchase list supports supplier, source, status, date, external reference, and invoice reference filters.</p>

      <section>
        <label style={{ fontSize: 13, marginRight: 8 }}>
          Status
          <select style={{ ...inputStyle, marginLeft: 6 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.values(PurchaseStatus).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <button style={buttonStyle} onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Cancel" : "Create Purchase"}</button>
      </section>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Purchase</h2>
          <label style={{ fontSize: 13, marginRight: 8 }}>
            Supplier
            <select style={{ ...inputStyle, marginLeft: 6 }} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Unspecified</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13, marginRight: 8 }}>
            Source
            <select style={{ ...inputStyle, marginLeft: 6 }} value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {Object.values(PurchaseSourceType).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Currency is EUR only.</p>

          <h3>Invoice details (optional)</h3>
          {purchaseHeaderFields.map((f) => (
            <label key={f.key} style={{ fontSize: 13, marginRight: 8, display: "inline-block", marginBottom: 6 }}>
              {f.label}
              {f.kind === "notes" ? (
                <textarea style={{ ...inputStyle, marginLeft: 6, verticalAlign: "top" }} value={header[f.key]} onChange={(e) => setHeader((h) => ({ ...h, [f.key]: e.target.value }))} />
              ) : (
                <input
                  style={{ ...inputStyle, marginLeft: 6 }}
                  type={f.kind === "money" ? "number" : f.kind === "date" ? "date" : "text"}
                  min={f.kind === "money" ? 0 : undefined}
                  step={f.kind === "money" ? "0.01" : undefined}
                  value={header[f.key]}
                  onChange={(e) => setHeader((h) => ({ ...h, [f.key]: e.target.value }))}
                />
              )}
            </label>
          ))}

          <h3>Lines</h3>
          {lines.map((line, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <input style={inputStyle} placeholder="Title" value={line.titleSnapshot} onChange={(e) => updateLine(i, { titleSnapshot: e.target.value })} />
              <input style={inputStyle} type="number" min={1} placeholder="Quantity" value={line.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} />
              <input style={inputStyle} type="number" min={0} step="0.01" placeholder="Unit cost (EUR)" value={line.unitPurchaseCost} onChange={(e) => updateLine(i, { unitPurchaseCost: e.target.value })} />
              <input style={inputStyle} placeholder="Product ID (optional)" value={line.productId} onChange={(e) => updateLine(i, { productId: e.target.value })} />
              <input style={inputStyle} placeholder="Lot reference (optional)" value={line.sourceLineReference} onChange={(e) => updateLine(i, { sourceLineReference: e.target.value })} />
              <input style={inputStyle} type="number" min={0} step="0.001" placeholder="Weight (optional)" value={line.weight} onChange={(e) => updateLine(i, { weight: e.target.value })} />
              {lines.length > 1 && (
                <button style={buttonStyle} onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
              )}
            </div>
          ))}
          <button style={buttonStyle} onClick={() => setLines((prev) => [...prev, emptyLine()])}>Add line</button>

          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>
              {createBusy ? "Creating…" : "Submit Purchase"}
            </button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading purchases...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && purchases.length === 0 && <p>No purchases match the current filters.</p>}

      {!loading && !loadError && purchases.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Supplier</th><th>Source</th><th>References</th><th>Dates</th><th>Status</th><th>Total</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((row) => {
              const p = mapPurchase(row);
              return (
                <tr key={p.id}>
                  <td>{supplierName(p.supplierId)}</td>
                  <td>{p.source}</td>
                  <td>{p.references}</td>
                  <td>{p.dates}</td>
                  <td>{p.status}</td>
                  <td>{p.total}</td>
                  <td><a href={p.href}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
