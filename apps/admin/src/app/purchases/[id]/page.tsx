"use client";

import { useEffect, useState } from "react";
import { LandedCostAllocationMethod, PurchaseStatus } from "@noctella/shared";
import {
  allocatePurchaseCosts,
  allocationMethodLabels,
  cancelPurchase,
  costCompleteness,
  mapLandedCostSummary,
  markPurchaseOrdered,
  productLinkWarning,
  purchasingApi,
  receiptStatus,
  receivePurchase,
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

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading purchase...</p>;
  if (loadError && !purchase) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!purchase) return null;

  const blockedByOther = busyCount > 0;
  const canMarkOrdered = purchase.status === PurchaseStatus.Draft;
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
        <h2>Lines — {receiptStatus(purchase)}</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Title</th><th>Ordered</th><th>Received</th><th>Remaining</th><th>Unit cost</th><th>Product</th>
            </tr>
          </thead>
          <tbody>
            {purchase.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.titleSnapshot}</td>
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
            Allocates shipping/customs/packaging/buyer-premium/tax/misc costs across lines. This does not update product purchase cost fields and does not post any finance-ledger entry.
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
