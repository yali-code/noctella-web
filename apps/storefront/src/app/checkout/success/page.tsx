"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { getPaymentStatus } from "@/lib/payments";
import { getPaymentSelection } from "@/lib/paymentSelection";
import { getCreatedOrder, type CreateOrderResult } from "@/lib/orders";
import { paymentStatusMessage, startPaymentStatusPolling, type SafePaymentStatus } from "@/lib/stripeCheckoutFlow";

/**
 * Sprint 134: the `legacy` (Cash on Delivery) branch is the only reachable path for the current
 * COD-only launch - no code path ever sets a Stripe paymentId today (see the Sprint 134 Discovery
 * findings). The `view`/`paymentStatusMessage` branch below remains fully intact and unmodified
 * for when Stripe is explicitly re-enabled in the future (see payments/paymentService.ts's
 * stripePublicCheckoutEnabled) - it is preserved, not deleted, per the approved Stripe-dormant
 * requirement.
 */
function CodConfirmation({ order }: { order: CreateOrderResult }) {
  return (
    <>
      <p style={{ fontSize: 15 }}>
        Thank you — your order <strong>{order.orderNumber}</strong> has been placed.
      </p>
      <p style={{ fontSize: 14, color: "var(--noctella-ivory)" }}>
        Payment method: <strong>Cash on Delivery</strong>. No payment has been collected yet — you
        pay when your order arrives.
      </p>
      {order.shippingMethodLabel && (
        <p style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Shipping: {order.shippingMethodLabel}
          {order.shippingAmount !== undefined && (order.shippingAmount === 0 ? " (Free)" : ` (€${order.shippingAmount.toFixed(2)})`)}
        </p>
      )}
      {order.totalAmount !== undefined && (
        <p style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>Total due on delivery: €{order.totalAmount.toFixed(2)}</p>
      )}
    </>
  );
}

function Content() {
  const params = useSearchParams();
  const [state, setState] = useState<SafePaymentStatus | null>(null);
  const paymentId = params.get("paymentId") ?? getPaymentSelection()?.paymentId;

  useEffect(() => (paymentId ? startPaymentStatusPolling(paymentId, getPaymentStatus, setState) : undefined), [paymentId]);

  const legacy = !paymentId ? getCreatedOrder() : null;
  const view = paymentStatusMessage(state);

  return (
    <section style={{ padding: "60px 40px", maxWidth: 560, margin: "0 auto", textAlign: "center" }}>
      <h1>{legacy ? "Order Confirmed" : "Payment Status"}</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {legacy ? (
          <CodConfirmation order={legacy} />
        ) : paymentId ? (
          <p>{view.message}</p>
        ) : (
          // Sprint 134: neutral, accurate wording for direct/stale navigation with no order in
          // this browser's state - never the Stripe-flavored "Your payment is being confirmed.",
          // which would falsely imply an in-progress payment that does not exist.
          <p style={{ color: "var(--noctella-aged-bronze)" }}>No order was found for this session.</p>
        )}
      </div>
      <p style={{ marginTop: 16 }}>
        <Link href="/shop">Continue Shopping</Link>
      </p>
    </section>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<section style={{ padding: "60px 40px", textAlign: "center" }}>Loading payment status...</section>}>
      <Content />
    </Suspense>
  );
}
