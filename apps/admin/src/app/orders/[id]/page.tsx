"use client";

import { OrderStatus } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  completeSale,
  getAvailableOrderStatusActions,
  getOrder,
  updateOrderStatus,
  type OrderStatusAction,
  type OrderWithItems,
} from "@/lib/orders";
import { canAct, financialSummary, readinessSummary, safeErrorSummary, type ShipmentRow } from "@/lib/shipments";

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<OrderStatusAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusActionError, setStatusActionError] = useState<string | null>(null);
  const [completeSaleBusy, setCompleteSaleBusy] = useState(false);
  const [completeSaleError, setCompleteSaleError] = useState<string | null>(null);
  const [completeSaleIssues, setCompleteSaleIssues] = useState<string[] | null>(null);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [readiness, setReadiness] = useState<{ ready: boolean; issues: string[] } | null>(null);
  const [financials, setFinancials] = useState<any>(null);
  const [returns, setReturns] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [reversal, setReversal] = useState<any>(null);
  const [salesBridge, setSalesBridge] = useState<any>(null);
  const [invoiceBridge, setInvoiceBridge] = useState<any[]>([]);
  const [financeBridge, setFinanceBridge] = useState<any>(null);
  const [erpBridgeError, setErpBridgeError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getOrder(params.id)
      .then((loaded) => {
        setOrder(loaded);
        fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${loaded.id}/shipments`).then((r) => r.ok ? r.json() : []).then(setShipments).catch(() => setShipments([]));
        fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${loaded.id}/complete-sale/readiness`).then((r) => r.ok ? r.json() : null).then((r) => setReadiness(r ? readinessSummary(r) : null)).catch(() => setReadiness(null));
        fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${loaded.id}/returns`).then((r) => r.ok ? r.json() : []).then(setReturns).catch(() => setReturns([]));
        fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${loaded.id}/refunds`).then((r) => r.ok ? r.json() : []).then(setRefunds).catch(() => setRefunds([]));
        fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${loaded.id}/sale-reversal/readiness`).then((r) => r.ok ? r.json() : null).then(setReversal).catch(() => setReversal(null));
        setErpBridgeError(null);
        fetch(`/api/erp/orders/${loaded.id}/sales-summary`).then((r) => r.ok ? r.json() : Promise.reject(new Error("sales-summary"))).then(setSalesBridge).catch(() => { setSalesBridge(null); setErpBridgeError("Unable to load ERP sales, invoice, and finance data."); });
        fetch(`/api/erp/orders/${loaded.id}/invoices`).then((r) => r.ok ? r.json() : Promise.reject(new Error("invoices"))).then((r) => setInvoiceBridge(r.items ?? [])).catch(() => { setInvoiceBridge([]); setErpBridgeError("Unable to load ERP sales, invoice, and finance data."); });
        fetch(`/api/erp/finance/orders/${loaded.id}`).then((r) => r.ok ? r.json() : Promise.reject(new Error("finance"))).then(setFinanceBridge).catch(() => { setFinanceBridge(null); setErpBridgeError("Unable to load ERP sales, invoice, and finance data."); });
      })
      .catch((err) => setError(err.message ?? "Failed to load order"))
      .finally(() => setLoading(false));
  }, [params.id]);

  async function handleOrderStatusAction(action: OrderStatusAction, target: OrderStatus) {
    if (!order) return;
    setBusyAction(action);
    setStatusActionError(null);
    try {
      const updated = await updateOrderStatus(order.id, target);
      setOrder(updated);
    } catch (err) {
      setStatusActionError(err instanceof Error ? err.message : "Failed to update order status");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCompleteSale() {
    if (!order) return;
    setCompleteSaleBusy(true);
    setCompleteSaleError(null);
    setCompleteSaleIssues(null);
    try {
      const result = await completeSale(order.id);
      if (result.status === "blocked") {
        setCompleteSaleIssues(result.issues ?? []);
        return;
      }
      // Success (freshly completed) or alreadyCompleted: reload from the server
      // rather than constructing an optimistic Completed order locally.
      const refreshed = await getOrder(order.id);
      setOrder(refreshed);
      fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/orders/${refreshed.id}/complete-sale/readiness`).then((r) => r.ok ? r.json() : null).then((r) => setReadiness(r ? readinessSummary(r) : null)).catch(() => setReadiness(null));
    } catch (err) {
      setCompleteSaleError(err instanceof Error ? err.message : "Failed to complete sale");
    } finally {
      setCompleteSaleBusy(false);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading order...</p>;

  if (error && !order) {
    return (
      <div>
        <h1>Order</h1>
        <p style={{ color: "#c86a6a" }}>{error}</p>
        <Link href="/orders">Back to Orders</Link>
      </div>
    );
  }

  if (!order) return null;

  return (
    <div>
      <Link href="/orders" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
        ← Back to Orders
      </Link>
      <h1>{order.orderNumber}</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Customer / Contact</h3>
          <Row label="Name" value={order.shippingAddress.fullName || order.billingAddress.fullName} />
          <Row label="Email" value={order.guestEmail} />
          {order.shippingAddress.phone && <Row label="Phone" value={order.shippingAddress.phone} />}
          {order.notes && <Row label="Customer Note" value={order.notes} />}
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Shipping Address</h3>
          <AddressRows address={order.shippingAddress} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Billing Address</h3>
          <AddressRows address={order.billingAddress} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Payment</h3>
          <Row label="Provider" value={order.paymentProvider ?? "—"} />
          <Row label="Status" value={order.paymentStatus} />
          <Row label="Reference" value={order.paymentReference ?? "—"} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Order Status</h3>
          <Row label="Current Status" value={order.status} />
          {statusActionError && (
            <p role="alert" style={{ color: "#c86a6a" }}>
              {statusActionError}
            </p>
          )}
          {getAvailableOrderStatusActions(order.status).map((a) => (
            <button
              key={a.action}
              disabled={busyAction !== null}
              onClick={() => handleOrderStatusAction(a.action, a.target)}
              style={buttonStyle}
            >
              {busyAction === a.action ? a.busyLabel : a.label}
            </button>
          ))}
          {getAvailableOrderStatusActions(order.status).length === 0 &&
            (order.status === OrderStatus.Completed || order.status === OrderStatus.Cancelled) && (
              <p style={{ color: "var(--noctella-aged-bronze)" }}>No further status actions are available.</p>
            )}
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Totals</h3>
          <Row label="Subtotal" value={order.subtotalAmount.toFixed(2)} />
          <Row label="Shipping" value={order.shippingAmount.toFixed(2)} />
          <Row label="Tax" value={order.taxAmount.toFixed(2)} />
          <Row label="Total" value={order.totalAmount.toFixed(2)} />
          <Row label="Currency" value={order.currency} />
          <Row label="Created" value={new Date(order.createdAt).toLocaleString()} />
          <Row label="Updated" value={new Date(order.updatedAt).toLocaleString()} />
        </section>
      </div>



      <section className="noctella-panel" style={{ padding: 20, marginTop: 20 }}>
        <h3>Shipment & Complete Sale</h3>
        {shipments.length === 0 ? <p>No shipment yet. Use Create Shipment to start fulfillment.</p> : shipments.map((shipment) => (
          <div key={shipment.id} style={{ marginBottom: 12 }}>
            <Row label="Shipment" value={`${shipment.carrierCode} / ${shipment.status}`} />
            <Row label="Tracking" value={shipment.trackingNumber ?? "—"} />
            <Row label="Marketplace fulfillment" value={shipment.marketplaceFulfillmentStatus ?? "n/a"} />
            <Row label="Error" value={safeErrorSummary(shipment.lastError) || "—"} />
            <button disabled={!canAct(shipment.status, "ready")} style={buttonStyle}>Mark Ready</button>
            <button disabled={!canAct(shipment.status, "ship")} style={buttonStyle}>Ship</button>
            <button disabled={!canAct(shipment.status, "deliver")} style={buttonStyle}>Deliver</button>
          </div>
        ))}
        <button style={buttonStyle}>Create Shipment</button>
        <button style={buttonStyle}>Assign Tracking</button>
        {order.status !== OrderStatus.Completed && (
          <button disabled={!readiness?.ready || completeSaleBusy} onClick={handleCompleteSale} style={buttonStyle}>
            {completeSaleBusy ? "Completing Sale..." : "Complete Sale"}
          </button>
        )}
        {readiness && !readiness.ready && <p style={{ color: "#c86a6a" }}>{readiness.issues.join(", ")}</p>}
        {completeSaleIssues && completeSaleIssues.length > 0 && (
          <p role="alert" style={{ color: "#c86a6a" }}>
            {completeSaleIssues.join(", ")}
          </p>
        )}
        {completeSaleError && (
          <p role="alert" style={{ color: "#c86a6a" }}>
            {completeSaleError}
          </p>
        )}
        <Row label="Readiness" value={readiness?.ready ? "Ready" : "Blocked"} />
        <Row label="Financial profit" value={String(financialSummary(financials).profit)} />
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20 }}>
        <h3>Returns, Refunds & Sale Reversal</h3>
        <button style={buttonStyle}>Create Return</button>
        <Row label="Return requests" value={String(returns.length)} />
        {returns.map((ret) => <Row key={ret.id} label={`Return ${ret.id}`} value={`${ret.status} / ${ret.reason}`} />)}
        <Row label="Refund summary" value={`${refunds.reduce((sum, refund) => sum + Number(refund.totalAmount ?? 0), 0).toFixed(2)} refunded`} />
        <Row label="Refundable balance" value={(order.totalAmount - refunds.reduce((sum, refund) => sum + Number(refund.totalAmount ?? 0), 0)).toFixed(2)} />
        <Row label="Sale reversal readiness" value={reversal?.ready ? "Ready" : (reversal?.reasons?.join(", ") ?? "Unknown")} />
        <Row label="Adjusted net revenue" value={(order.totalAmount - refunds.reduce((sum, refund) => sum + Number(refund.totalAmount ?? 0), 0)).toFixed(2)} />
        <Row label="Adjusted financial summary" value={financials ? JSON.stringify(financials) : "Pending sale financials"} />
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20 }}>
        <h3>ERP Sales, Invoices & Finance Bridge</h3>
        {erpBridgeError && <p role="alert">{erpBridgeError}</p>}
        <Row label="Sales summary" value={salesBridge ? `${salesBridge.channel} / ${salesBridge.completionStatus} / ${salesBridge.paymentStatus}` : "Unavailable"} />
        <Row label="Invoice status" value={salesBridge?.invoiceNumber ?? salesBridge?.invoiceStatus ?? "No invoice"} />
        <button style={buttonStyle}>Create Invoice Draft</button>
        {invoiceBridge.length === 0 ? <p>No ERP invoices yet.</p> : invoiceBridge.map((invoice) => (
          <div key={invoice.id}>
            <Row label={`Invoice ${invoice.invoiceNumber ?? invoice.id}`} value={`${invoice.status} / ${invoice.invoiceType} / ${Number(invoice.totalAmount ?? 0).toFixed(2)}`} />
            <button disabled={invoice.status !== "Draft"} style={buttonStyle}>Issue</button>
            <button disabled={! ["Draft", "Issued"].includes(invoice.status)} style={buttonStyle}>Cancel</button>
            <button disabled={invoice.status !== "Issued"} style={buttonStyle}>Mark Paid</button>
          </div>
        ))}
        <Row label="Complete-sale readiness" value={readiness?.ready ? "Ready" : (readiness?.issues?.join(", ") ?? "Unknown")} />
        <Row label="Gross revenue" value={String(financeBridge?.summary?.grossRevenue ?? salesBridge?.financials?.grossRevenue ?? "Pending")} />
        <Row label="Refund adjustments" value={String(salesBridge?.financials?.totalRefunded ?? refunds.reduce((sum, refund) => sum + Number(refund.totalAmount ?? 0), 0))} />
        <Row label="Reversal adjustments" value={reversal?.ready ? "Ready" : (reversal?.reasons?.join(", ") ?? "No reversal")} />
        <Row label="Adjusted profit completeness" value={financeBridge?.summary?.adjustedCompleteness ?? salesBridge?.financials?.adjustedCompleteness ?? "Incomplete"} />
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20, overflowX: "auto" }}>
        <h3>Order Items</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={thStyle}>Image</th>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>Slug</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Unit</th>
              <th style={thStyle}>Line Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>
                  {item.productImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.productImageUrl} alt="" style={{ width: 44, height: 44, objectFit: "cover" }} />
                  ) : (
                    "—"
                  )}
                </td>
                <td style={tdStyle}>{item.productTitle}</td>
                <td style={tdStyle}>{item.productSlug}</td>
                <td style={tdStyle}>{item.productType}</td>
                <td style={tdStyle}>{item.quantity}</td>
                <td style={tdStyle}>{item.unitPrice.toFixed(2)}</td>
                <td style={tdStyle}>{item.totalPrice.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AddressRows({ address }: { address: OrderWithItems["shippingAddress"] }) {
  return (
    <>
      <Row label="Name" value={address.fullName} />
      <Row label="Line 1" value={address.line1} />
      {address.line2 && <Row label="Line 2" value={address.line2} />}
      <Row label="City" value={address.city} />
      {address.region && <Row label="Region" value={address.region} />}
      <Row label="Postal Code" value={address.postalCode} />
      <Row label="Country" value={address.country} />
    </>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value || "—"}</span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  ...inputStyle,
  marginLeft: 8,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};
