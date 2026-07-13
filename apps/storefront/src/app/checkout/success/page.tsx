"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCreatedOrder, type CreateOrderResult } from "@/lib/orders";

export default function CheckoutSuccessPage() {
  const [order, setOrder] = useState<CreateOrderResult | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setOrder(getCreatedOrder());
    setLoaded(true);
  }, []);

  if (!loaded) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
          Loading...
        </p>
      </section>
    );
  }

  return (
    <section style={{ padding: "60px 40px", maxWidth: 560, margin: "0 auto", textAlign: "center" }}>
      <h1>Order Created</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      {order ? (
        <div className="noctella-panel" style={{ padding: 20 }}>
          <p style={{ marginTop: 0 }}>Thank you. Your order has been created.</p>
          <p style={{ color: "var(--noctella-bright-star-gold)", fontSize: 20, marginBottom: 0 }}>
            {order.orderNumber}
          </p>
        </div>
      ) : (
        <p style={{ color: "var(--noctella-aged-bronze)" }}>No created order was found on this device.</p>
      )}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 24 }}>
        <Link href="/shop" style={{ fontSize: 14 }}>
          Continue Shopping
        </Link>
        <Link href="/checkout/review" style={{ fontSize: 14, color: "var(--noctella-aged-bronze)" }}>
          Back to Checkout Review
        </Link>
      </div>
    </section>
  );
}
