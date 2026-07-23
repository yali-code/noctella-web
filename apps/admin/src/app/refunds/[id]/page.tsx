"use client";

import { useEffect, useState } from "react";
import { canCancelRefund, canRetryRefund, canSubmitRefund, cancelRefund, getRefund, retryRefund, submitRefund, type RefundRow } from "@/lib/returns";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

export default function RefundDetail({ params }: { params: { id: string } }) {
  const [r, setR] = useState<RefundRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    getRefund(params.id)
      .then(setR)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load refund"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading refund...</p>;
  if (loadError && !r) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!r) return null;

  const blockedByOther = busyCount > 0;
  const paymentProviderNotConfigured = !!r.lastError && r.lastError.includes("REFUND_PAYMENT_PROVIDER_NOT_CONFIGURED");

  return (
    <main>
      <h1>Refund {r.id}</h1>
      <p>Status {r.status} · Retry {String(canRetryRefund(r))} · Cancel {String(canCancelRefund(r))}</p>
      <p>
        Order <a href={`/orders/${r.orderId}`}>{r.orderId}</a>
        {r.returnRequestId ? <> · Return <a href={`/returns/${r.returnRequestId}`}>{r.returnRequestId}</a></> : null}
      </p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}

      <h2>Breakdown</h2>
      <p>Subtotal {r.subtotalAmount}, shipping {r.shippingAmount}, tax {r.taxAmount}, total {r.totalAmount} {r.currency}</p>
      <h2>Allocations</h2>
      <pre>{JSON.stringify(r.allocations ?? [], null, 2)}</pre>
      <p>External refund: {r.externalRefundId ?? "not submitted"}</p>

      {paymentProviderNotConfigured ? (
        <p role="alert" style={{ color: "#c86a6a" }}>
          This refund cannot be executed automatically: no payment-provider integration is configured for direct payment refunds. A marketplace-channel refund does not have this limitation. This requires operational setup, not a retry.
        </p>
      ) : (
        r.lastError && <p role="alert" style={{ color: "#c86a6a" }}>Last error: {r.lastError}</p>
      )}

      <section>
        <h2>Actions</h2>

        <ConfirmButton
          label="Submit"
          eligible={canSubmitRefund(r)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => submitRefund(r.id).then(() => {})}
        />

        <ConfirmButton
          label="Retry"
          eligible={canRetryRefund(r)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => retryRefund(r.id).then(() => {})}
        />

        <ConfirmButton
          label="Cancel refund"
          eligible={canCancelRefund(r)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelRefund(r.id).then(() => {})}
        />
      </section>
    </main>
  );
}
