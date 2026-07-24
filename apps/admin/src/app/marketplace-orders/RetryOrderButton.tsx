"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { retryMarketplaceOrder } from "@/lib/marketplaceSync";

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  cursor: "pointer",
};

/** Shared by both the list and detail pages. No confirmation - retry is already eligibility-gated server-side and idempotent. */
export function RetryOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  async function handleRetry() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSucceeded(false);
    try {
      await retryMarketplaceOrder(orderId);
      setSucceeded(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry import");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button disabled={busy} style={buttonStyle} onClick={handleRetry}>{busy ? "Retrying…" : "Retry"}</button>
      {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      {succeeded && <span style={{ color: "var(--noctella-bright-star-gold)", marginLeft: 6 }}>Retried.</span>}
    </span>
  );
}
