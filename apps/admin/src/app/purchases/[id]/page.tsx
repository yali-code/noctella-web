"use client";

import { useEffect, useState } from "react";
import { LandedCostAllocationMethod, PurchaseStatus } from "@noctella/shared";
import {
  allocatePurchaseCosts,
  allocationMethodLabels,
  buildPurchaseHeaderPayload,
  cancelPurchase,
  costCompleteness,
  mapLandedCostSummary,
  markPurchaseOrdered,
  productLinkWarning,
  purchaseHeaderDraftFrom,
  purchaseHeaderFields,
  purchasingApi,
  receiptStatus,
  receivePurchase,
  updatePurchase,
  type PurchaseHeaderDraft,
} from "@/lib/erpPurchasingBridge";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

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

export default function PurchaseDetailPage({ params }: { params: { id: string } }) {
  const [purchase, setPurchase] = useState<any>(null);
  const [supplier, setSupplier] = useState<any>(null);
  const [landed, setLanded] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    purchasingApi
      .purchase(params.id)
      .then((p) => {
        setPurchase(p);
        purchasingApi.landed(params.id).then(setLanded).catch(() => setLanded(null));
        if (p.supplierId) purchasingApi.supplier(p.supplierId).then(setSupplier).catch(() => setSupplier(null));
        else setSupplier(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load purchase"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  const [allocationMethod, setAllocationMethod] = useState<string>(LandedCostAllocationMethod.Equal);

  const [receiveArmed, setReceiveArmed] = useState(false);
  const [receiveKey, setReceiveKey] = useState<string | null>(null);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receiveSuccess, setReceiveSuccess] = useState(false);

  function armReceive() {
    setReceiveArmed(true);
    setReceiveKey(crypto.randomUUID());
    setReceiveQuantities({});
    setReceiveError(null);
    setReceiveSuccess(false);
  }
  function cancelReceiveForm() {
    setReceiveArmed(false);
    setReceiveKey(null);
    setReceiveError(null);
  }
  async function submitReceive() {
    if (receiveBusy || !receiveKey) return;
    setReceiveBusy(true);
    setBusyCount((c) => c + 1);
    setReceiveError(null);
    try {
      const remainingByLine = new Map(purchase.lines.map((l: any) => [l.id, l.quantity - l.receivedQuantity]));
      const lines = Object.entries(receiveQuantities)
        .filter(([, q]) => q !== "" && Number(q) > 0)
        .map(([purchaseLineId, q]) => {
          const qty = Number(q);
          const remaining = Number(remainingByLine.get(purchaseLineId) ?? 0);
          if (qty > remaining) throw new Error(`Received quantity cannot exceed the remaining quantity (${remaining})`);
          return { purchaseLineId, quantityReceived: qty };
        });
      if (!lines.length) throw new Error("Enter a received quantity for at least one line");
      await receivePurchase(purchase.id, { idempotencyKey: receiveKey, lines });
      setReceiveArmed(false);
      setReceiveKey(null);
      setReceiveSuccess(true);
      load();
    } catch (err) {
      setReceiveError(err instanceof Error ? err.message : "Failed to record receipt");
    } finally {
      setReceiveBusy(false);
      setBusyCount((c) => c - 1);
    }
  }

  const [editDraft, setEditDraft] = useState<PurchaseHeaderDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit() {
    setEditDraft(purchaseHeaderDraftFrom(purchase));
    setEditError(null);
  }
  async function submitEdit() {
    if (editBusy || !editDraft) return;
    setEditBusy(true);
    setBusyCount((c) => c + 1);
    setEditError(null);
    try {
      // updatePurchase generates a fresh idempotency key per submission attempt, like createPurchase.
      await updatePurchase(purchase.id, buildPurchaseHeaderPayload(editDraft), purchase.updatedAt);
      setEditDraft(null);
      load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update invoice details");
    } finally {
      setEditBusy(false);
      setBusyCount((c) => c - 1);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading purchase...</p>;
  if (loadError && !purchase) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!purchase) return null;

  const blockedByOther = busyCount > 0;
  const canMarkOrdered = purchase.status === PurchaseStatus.Draft;
  const canEditInvoice = purchase.status === PurchaseStatus.Draft;
  const canReceive = ![PurchaseStatus.Cancelled, PurchaseStatus.Received].includes(purchase.status) && purchase.lines.some((l: any) => l.quantity > l.receivedQuantity);
  const canAllocate = purchase.status !== PurchaseStatus.Received;
  const canCancel = ![PurchaseStatus.Received, PurchaseStatus.PartiallyReceived, PurchaseStatus.Cancelled].includes(purchase.status);
  const mapped = landed ? mapLandedCostSummary(landed) : null;

  return (
    <main>
      <h1>Purchase {purchase.erpReferenceId ?? purchase.id}</h1>
      <p>Supplier {supplier ? supplier.name : purchase.supplierId ?? "Unspecified"} · Source {purchase.sourceType} · Status {purchase.status}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>References: {[purchase.erpReferenceId, purchase.externalReference, purchase.invoiceReferenceNumber].filter(Boolean).join(" / ") || "—"}</p>
      <p>Ordered {purchase.orderedAt ?? "—"} · Received {purchase.receivedAt ?? "—"} · Created {purchase.createdAt}</p>

      <section>
        <h2>Invoice details</h2>
        <dl style={{ fontSize: 13, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px" }}>
          {purchaseHeaderFields.map((f) => {
            const v = purchase[f.key];
            return [
              <dt key={`${f.key}-dt`}>{f.label}</dt>,
              <dd key={`${f.key}-dd`} style={{ margin: 0, whiteSpace: "pre-wrap" }}>{v == null || v === "" ? "—" : f.kind === "money" ? `€${Number(v).toFixed(2)}` : String(v)}</dd>,
            ];
          })}
        </dl>
        {canEditInvoice && !editDraft && (
          <button style={buttonStyle} disabled={blockedByOther} onClick={openEdit}>Edit invoice details</button>
        )}
        {canEditInvoice && editDraft && (
          <div style={{ marginTop: 6 }}>
            {purchaseHeaderFields.map((f) => (
              <label key={f.key} style={{ fontSize: 13, marginRight: 8, display: "inline-block", marginBottom: 6 }}>
                {f.label}
                {f.kind === "notes" ? (
                  <textarea style={{ ...inputStyle, marginLeft: 6, verticalAlign: "top" }} value={editDraft[f.key]} onChange={(e) => setEditDraft((d) => d && { ...d, [f.key]: e.target.value })} />
                ) : (
                  <input
                    style={{ ...inputStyle, marginLeft: 6 }}
                    type={f.kind === "money" ? "number" : f.kind === "date" ? "date" : "text"}
                    min={f.kind === "money" ? 0 : undefined}
                    step={f.kind === "money" ? "0.01" : undefined}
                    value={editDraft[f.key]}
                    onChange={(e) => setEditDraft((d) => d && { ...d, [f.key]: e.target.value })}
                  />
                )}
              </label>
            ))}
            <div>
              <button disabled={editBusy} style={buttonStyle} onClick={submitEdit}>{editBusy ? "Saving…" : "Save invoice details"}</button>
              <button disabled={editBusy} style={buttonStyle} onClick={() => setEditDraft(null)}>Cancel edit</button>
            </div>
            {editError && <p role="alert" style={{ color: "#c86a6a" }}>{editError}</p>}
          </div>
        )}
      </section>

      <section>
        <h2>Lines — {receiptStatus(purchase)}</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Title</th><th>Lot ref</th><th>Ordered</th><th>Received</th><th>Remaining</th><th>Unit cost</th><th>Product</th>
            </tr>
          </thead>
          <tbody>
            {purchase.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.titleSnapshot}</td>
                <td>{l.sourceLineReference ?? "—"}</td>
                <td>{l.quantity}</td>
                <td>{l.receivedQuantity}</td>
                <td>{l.quantity - l.receivedQuantity}</td>
                <td>€{Number(l.unitPurchaseCost).toFixed(2)}</td>
                <td>{l.productId ?? "Unlinked"}{productLinkWarning(l) ? ` — ${productLinkWarning(l)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Landed cost — {mapped ? costCompleteness(mapped) : "Unavailable"}</h2>
        {mapped && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left" }}><th>Line</th><th>Base cost</th><th>Landed unit cost</th><th>Landed total</th></tr></thead>
            <tbody>
              {mapped.lines.map((l: any) => (
                <tr key={l.purchaseLineId}>
                  <td>{l.purchaseLineId}</td>
                  <td>€{Number(l.baseItemCost).toFixed(2)}</td>
                  <td>{l.landedUnitCost == null ? "Incomplete" : `€${Number(l.landedUnitCost).toFixed(2)}`}</td>
                  <td>{l.landedTotalCost == null ? "Incomplete" : `€${Number(l.landedTotalCost).toFixed(2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Actions</h2>

        <ConfirmButton
          label="Mark Ordered"
          eligible={canMarkOrdered}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => markPurchaseOrdered(purchase.id).then(() => {})}
        />

        {canReceive && !receiveArmed && (
          <button style={buttonStyle} disabled={blockedByOther} onClick={armReceive}>Receive</button>
        )}
        {receiveArmed && (
          <div style={{ marginTop: 6 }}>
            {purchase.lines.filter((l: any) => l.quantity > l.receivedQuantity).map((l: any) => (
              <div key={l.id} style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 13, marginRight: 6 }}>{l.titleSnapshot} (remaining {l.quantity - l.receivedQuantity})</span>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  max={l.quantity - l.receivedQuantity}
                  placeholder="Qty received"
                  value={receiveQuantities[l.id] ?? ""}
                  onChange={(e) => setReceiveQuantities((prev) => ({ ...prev, [l.id]: e.target.value }))}
                />
              </div>
            ))}
            <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
              Inventory is posted automatically and atomically with this receipt — there is no separate inventory-increase step.
            </p>
            <button disabled={receiveBusy} style={buttonStyle} onClick={submitReceive}>{receiveBusy ? "Submitting…" : "Confirm Receive"}</button>
            <button disabled={receiveBusy} style={buttonStyle} onClick={cancelReceiveForm}>Cancel</button>
            {receiveError && <p role="alert" style={{ color: "#c86a6a" }}>{receiveError}</p>}
          </div>
        )}
        {receiveSuccess && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Receive succeeded.</p>}

        <ConfirmButton
          label="Allocate Costs"
          eligible={canAllocate}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => allocatePurchaseCosts(purchase.id, { allocationMethod }).then(() => {})}
        >
          <select style={inputStyle} value={allocationMethod} onChange={(e) => setAllocationMethod(e.target.value)}>
            {[LandedCostAllocationMethod.Equal, LandedCostAllocationMethod.ByItemCost, LandedCostAllocationMethod.ByQuantity, LandedCostAllocationMethod.ByWeight].map((m) => (
              <option key={m} value={m}>{allocationMethodLabels[m]}</option>
            ))}
          </select>
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            Allocates shipping/customs/packaging/buyer-premium/tax/misc costs across lines. This does not post any finance-ledger entry. For a quantity-1 line linked to a product whose purchase cost is not yet set, this also syncs that product&apos;s purchase cost from the resulting landed unit cost (quantity-greater-than-1 lines are left untouched — a weighted-average/FIFO decision is deferred).
          </p>
        </ConfirmButton>

        <ConfirmButton
          label="Cancel Purchase"
          eligible={canCancel}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelPurchase(purchase.id).then(() => {})}
        />
      </section>
    </main>
  );
}
