"use client";

import { useEffect, useState } from "react";
import {
  approveReturn,
  authorizeReturn,
  cancelReturn,
  canTransitionReturn,
  completeReturn,
  getReturn,
  getReturnEvents,
  getReturnReadiness,
  inspectReturnItem,
  markReturnInTransit,
  receiveReturn,
  rejectReturn,
  returnOrderLink,
  returnShipmentLink,
  stockDispositionLabel,
  type ReturnRow,
} from "@/lib/returns";
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

const stockDispositions = ["return_to_stock", "quarantine", "damaged", "parts", "discard", "no_stock_change"];

export default function ReturnDetail({ params }: { params: { id: string } }) {
  const [r, setR] = useState<ReturnRow | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [ready, setReady] = useState<{ ready: boolean; reasons: string[]; allowedActions: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    Promise.all([getReturn(params.id), getReturnEvents(params.id), getReturnReadiness(params.id)])
      .then(([returnRow, eventRows, readiness]) => {
        setR(returnRow);
        setEvents(eventRows as any[]);
        setReady(readiness);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load return"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  const [inspectItemId, setInspectItemId] = useState("");
  const [inspectQty, setInspectQty] = useState("");
  const [inspectDisposition, setInspectDisposition] = useState("");
  const [inspectCondition, setInspectCondition] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [partial, setPartial] = useState(false);
  const [note, setNote] = useState("");

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading return...</p>;
  if (loadError && !r) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!r) return null;

  const selectedItem = r.items?.find((i) => i.id === inspectItemId) ?? r.items?.[0];
  const blockedByOther = busyCount > 0;

  return (
    <main>
      <h1>Return {r.id}</h1>
      <p>
        Order <a href={returnOrderLink(r)}>{r.orderId}</a>
        {returnShipmentLink(r) ? <> · <a href={returnShipmentLink(r)}>Shipment</a></> : null}
      </p>
      <p>
        Status {r.status} · Marketplace {r.channel ?? "manual"} · Ready {String(ready?.ready)} {ready?.reasons.join(", ")}
      </p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}

      <section>
        <h2>Items</h2>
        {r.items?.map((i) => (
          <div key={i.id}>
            {i.orderItemId}: requested {i.quantityRequested}, approved {i.quantityApproved ?? "—"}, received {i.quantityReceived ?? "—"}, {i.condition ?? "not inspected"}, {stockDispositionLabel(i.stockDisposition)}
          </div>
        ))}
      </section>

      <section>
        <h2>Actions</h2>

        <ConfirmButton
          label="Authorize"
          eligible={canTransitionReturn(r.status, "authorize")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => authorizeReturn(r.id).then(() => {})}
        />

        <ConfirmButton
          label="Reject"
          eligible={canTransitionReturn(r.status, "reject")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => rejectReturn(r.id, { internalNote: note || undefined }).then(() => {})}
        >
          <input style={inputStyle} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </ConfirmButton>

        <ConfirmButton
          label="Mark in transit"
          eligible={canTransitionReturn(r.status, "in-transit")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => markReturnInTransit(r.id, { returnCarrierCode: carrier || undefined, returnTrackingNumber: tracking || undefined }).then(() => {})}
        >
          <input style={inputStyle} placeholder="Carrier (optional)" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          <input style={inputStyle} placeholder="Tracking number (optional)" value={tracking} onChange={(e) => setTracking(e.target.value)} />
        </ConfirmButton>

        <ConfirmButton
          label="Receive"
          eligible={canTransitionReturn(r.status, "receive")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => receiveReturn(r.id).then(() => {})}
        />

        <ConfirmButton
          label="Inspect item"
          eligible={canTransitionReturn(r.status, "inspect") && !!r.items?.length}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => {
            const itemId = inspectItemId || selectedItem?.id;
            const item = r.items?.find((i) => i.id === itemId);
            if (!item) throw new Error("Select an item to inspect");
            const qty = inspectQty === "" ? undefined : Number(inspectQty);
            if (qty !== undefined && (Number.isNaN(qty) || qty > item.quantityRequested)) {
              throw new Error(`Received quantity cannot exceed the requested quantity (${item.quantityRequested})`);
            }
            return inspectReturnItem(r.id, {
              orderItemId: item.orderItemId,
              quantityReceived: qty,
              stockDisposition: inspectDisposition || undefined,
              condition: inspectCondition || undefined,
            }).then(() => {});
          }}
        >
          <select style={inputStyle} value={inspectItemId || selectedItem?.id || ""} onChange={(e) => setInspectItemId(e.target.value)}>
            {r.items?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.orderItemId} (requested {i.quantityRequested})
              </option>
            ))}
          </select>
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={selectedItem?.quantityRequested}
            placeholder="Qty received"
            value={inspectQty}
            onChange={(e) => setInspectQty(e.target.value)}
          />
          <select style={inputStyle} value={inspectDisposition} onChange={(e) => setInspectDisposition(e.target.value)}>
            <option value="">Disposition…</option>
            {stockDispositions.map((d) => (
              <option key={d} value={d}>{stockDispositionLabel(d)}</option>
            ))}
          </select>
          <input style={inputStyle} placeholder="Condition (optional)" value={inspectCondition} onChange={(e) => setInspectCondition(e.target.value)} />
        </ConfirmButton>

        <ConfirmButton
          label="Approve"
          eligible={canTransitionReturn(r.status, "approve")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => approveReturn(r.id, { partial }).then(() => {})}
        >
          <label style={{ fontSize: 13, marginRight: 8 }}>
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} /> Partial approval
          </label>
        </ConfirmButton>

        <ConfirmButton
          label="Complete"
          confirmLabel="Confirm complete (inventory restores automatically)"
          eligible={canTransitionReturn(r.status, "complete")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => completeReturn(r.id).then(() => {})}
        >
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            Inventory for items marked &quot;Return to stock&quot; is restored automatically by the backend when this return completes. There is no separate restore-inventory action.
          </p>
        </ConfirmButton>

        <ConfirmButton
          label="Cancel return"
          eligible={canTransitionReturn(r.status, "cancel")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelReturn(r.id, { internalNote: note || undefined }).then(() => {})}
        >
          <input style={inputStyle} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </ConfirmButton>
      </section>

      <section>
        <h2>Timeline</h2>
        {events.map((e: any) => (
          <div key={e.id}>{e.createdAt} {e.eventType} {e.previousStatus} → {e.newStatus}</div>
        ))}
      </section>
    </main>
  );
}
