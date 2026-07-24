"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { syncExternalListing } from "@/lib/marketplaceSync";

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  cursor: "pointer",
};

/** Each row owns its own busy/error/success state, so only its own request is ever in flight. */
export function SyncListingButton({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  async function handleSync() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSucceeded(false);
    try {
      await syncExternalListing(listingId);
      setSucceeded(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync listing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button disabled={busy} style={buttonStyle} onClick={handleSync}>{busy ? "Syncing…" : "Sync now"}</button>
      {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      {succeeded && <span style={{ color: "var(--noctella-bright-star-gold)", marginLeft: 6 }}>Synced.</span>}
    </span>
  );
}
