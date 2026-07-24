"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  assignTracking,
  cancelShipment,
  canAct,
  canRetryFulfillment,
  deliverShipment,
  failShipment,
  getShipment,
  getShipmentEvents,
  getShipmentTracking,
  markReady,
  marketplaceOrderLink,
  retryMarketplaceFulfillment,
  returnShipment,
  safeErrorSummary,
  shipmentOrderLink,
  shipShipment,
} from "../../../lib/shipments";
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

export default function ShipmentDetailPage({ params }: { params: { id: string } }) {
  const [s, setS] = useState<any>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const [tracking, setTracking] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  const [trackingArmed, setTrackingArmed] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      getShipment(params.id),
      getShipmentEvents(params.id).catch(() => []),
      getShipmentTracking(params.id).catch(() => []),
    ])
      .then(([shipment, ev, tr]) => {
        setS(shipment);
        setEvents(ev);
        setTracking(tr);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load shipment"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  async function submitTracking() {
    if (trackingBusy) return;
    setTrackingBusy(true);
    setBusyCount((c) => c + 1);
    setTrackingError(null);
    try {
      await assignTracking(s.id, { trackingNumber: trackingNumber || undefined, trackingUrl: trackingUrl || undefined });
      setTrackingArmed(false);
      load();
    } catch (err) {
      setTrackingError(err instanceof Error ? err.message : "Failed to assign tracking");
    } finally {
      setTrackingBusy(false);
      setBusyCount((c) => c - 1);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading shipment...</p>;
  if (loadError && !s) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!s) return null;

  const blockedByOther = busyCount > 0;

  return (
    <main>
      <h1>Shipment {s.id}</h1>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>
        Order: <Link href={shipmentOrderLink(s)}>{s.orderId}</Link>{" "}
        {marketplaceOrderLink(s) ? <Link href={marketplaceOrderLink(s)!}>Marketplace order</Link> : null}
      </p>
      <p>{s.carrierCode} {s.trackingNumber} {s.status}</p>
      <p>Marketplace fulfillment: {s.marketplaceFulfillmentStatus ?? "n/a"}</p>
      <p>Error: {safeErrorSummary(s.lastError)}</p>

      <section>
        <h2>Assign Tracking</h2>
        {!trackingArmed ? (
          <button style={buttonStyle} disabled={blockedByOther} onClick={() => { setTrackingArmed(true); setTrackingNumber(s.trackingNumber ?? ""); setTrackingUrl(""); setTrackingError(null); }}>
            Assign Tracking
          </button>
        ) : (
          <div>
            <input style={inputStyle} placeholder="Tracking number" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
            <input style={inputStyle} placeholder="Tracking URL" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} />
            <button style={buttonStyle} disabled={trackingBusy} onClick={submitTracking}>{trackingBusy ? "Submitting…" : "Confirm Tracking"}</button>
            <button style={buttonStyle} disabled={trackingBusy} onClick={() => { setTrackingArmed(false); setTrackingError(null); }}>Cancel</button>
            {trackingError && <p role="alert" style={{ color: "#c86a6a" }}>{trackingError}</p>}
          </div>
        )}
      </section>

      <section>
        <h2>Actions</h2>
        <ConfirmButton
          label="Mark Ready"
          eligible={canAct(s.status, "ready")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => markReady(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Ship"
          eligible={canAct(s.status, "ship")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => shipShipment(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Deliver"
          eligible={canAct(s.status, "deliver")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => deliverShipment(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Fail Delivery"
          eligible={canAct(s.status, "fail")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => failShipment(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Cancel"
          eligible={canAct(s.status, "cancel")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelShipment(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Return"
          eligible={canAct(s.status, "return")}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => returnShipment(s.id).then(() => {})}
        />
        <ConfirmButton
          label="Retry Fulfillment"
          eligible={canRetryFulfillment(s)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => retryMarketplaceFulfillment(s.id, s.channel).then(() => {})}
        />
      </section>

      <section>
        <h2>Items</h2>
        <pre>{JSON.stringify(s.items, null, 2)}</pre>
      </section>
      <section>
        <h2>Events</h2>
        <pre>{JSON.stringify(events, null, 2)}</pre>
      </section>
      <section>
        <h2>Tracking timeline</h2>
        <pre>{JSON.stringify(tracking, null, 2)}</pre>
      </section>
    </main>
  );
}
