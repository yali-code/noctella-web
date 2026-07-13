"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  getPaymentActionState,
  getPaymentSelection,
  updatePaymentSelectionStatus,
  type PaymentSelection,
} from "@/lib/paymentSelection";
import { getOrderDraft, type OrderDraft } from "@/lib/orderDraft";
import { cancelMockPayment, verifyMockPayment } from "@/lib/payments";
import { createOrderFromPaidPayment, saveCreatedOrder } from "@/lib/orders";

function formatProviderName(provider: string): string {
  return provider
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatStatus(status?: string): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function CheckoutPaymentConfirmPage() {
  const router = useRouter();
  const [selection, setSelection] = useState<PaymentSelection | null>(null);
  const [orderDraft, setOrderDraft] = useState<OrderDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"verify" | "cancel" | "order" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(getPaymentSelection());
    setOrderDraft(getOrderDraft());
    setLoaded(true);
  }, []);

  async function handleVerify() {
    if (!selection?.providerReference) return;
    setBusy("verify");
    setError(null);
    try {
      const result = await verifyMockPayment({
        provider: selection.provider,
        providerReference: selection.providerReference,
      });
      setSelection(updatePaymentSelectionStatus(result.status));
    } catch (err) {
      setSelection(updatePaymentSelectionStatus("failed"));
      setError(err instanceof ApiError ? err.message : "Verification failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (!selection?.providerReference) return;
    setBusy("cancel");
    setError(null);
    try {
      const result = await cancelMockPayment({
        provider: selection.provider,
        providerReference: selection.providerReference,
      });
      setSelection(updatePaymentSelectionStatus(result.status));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cancellation failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateOrder() {
    if (!selection || !orderDraft) return;
    setBusy("order");
    setError(null);
    try {
      const order = await createOrderFromPaidPayment(orderDraft, selection);
      saveCreatedOrder({ id: order.id, orderNumber: order.orderNumber });
      router.push("/checkout/success");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Order creation failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
          Loading...
        </p>
      </section>
    );
  }

  if (!selection || !selection.providerReference) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>Payment Confirmation</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>No initialized payment was found.</p>
        <Link href="/checkout/payment" style={{ fontSize: 14 }}>
          Back to Payment Selection
        </Link>
      </section>
    );
  }

  const status = selection.status ?? "pending";
  const { canVerify, canCancel, isFinal } = getPaymentActionState(status);

  return (
    <section style={{ padding: "48px 40px", maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
      <h1>Payment Confirmation</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && (
        <p role="alert" style={{ color: "#c86a6a", marginBottom: 16 }}>
          {error}
        </p>
      )}

      <div className="noctella-panel" style={{ padding: 20, textAlign: "left" }}>
        <Row label="Provider" value={formatProviderName(selection.provider)} />
        <Row label="Mock Reference" value={selection.providerReference} />
        {selection.amount !== undefined && (
          <Row label="Amount" value={`${selection.currency === "EUR" ? "€" : ""}${selection.amount.toFixed(2)}`} />
        )}
        {selection.currency && <Row label="Currency" value={selection.currency} />}
        <Row label="Status" value={formatStatus(status)} />
      </div>

      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 24, flexWrap: "wrap" }}>
        {canVerify && (
          <button onClick={handleVerify} disabled={busy !== null} style={primaryButtonStyle}>
            {busy === "verify" ? "Verifying..." : status === "failed" ? "Retry Verify" : "Verify Payment"}
          </button>
        )}
        {canCancel && (
          <button onClick={handleCancel} disabled={busy !== null} style={secondaryButtonStyle}>
            {busy === "cancel" ? "Cancelling..." : "Cancel Payment"}
          </button>
        )}
        {status === "paid" && (
          <button onClick={handleCreateOrder} disabled={busy !== null || !orderDraft} style={primaryButtonStyle}>
            {busy === "order" ? "Creating Order..." : "Create Order"}
          </button>
        )}
        {isFinal && status !== "paid" && (
          <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13 }}>This payment was cancelled.</p>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 24 }}>
        <Link href="/checkout/payment" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Back to Payment Selection
        </Link>
        <Link href="/checkout/review" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Back to Checkout Review
        </Link>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  fontSize: 14,
  cursor: "pointer",
};
