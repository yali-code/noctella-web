"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { resolveConflict } from "@/lib/stockSyncJobs";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
  marginLeft: 8,
  marginTop: 6,
  cursor: "pointer",
};

const OPEN_STATUS = "open";

/**
 * Only the three fixed actions the backend's resolveStockSyncConflict recognizes are ever sent -
 * no free-text action value. Mark Resolved/Ignore are consequential status changes and use the
 * shared ConfirmButton two-step confirm; Retry to Marketplace follows the existing retry-action
 * precedent (no confirmation, matches publish-job/background-job retry).
 */
export function ConflictActions({ conflictId, status }: { conflictId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySucceeded, setRetrySucceeded] = useState(false);

  const eligible = status === OPEN_STATUS;

  async function handleRetryToMarketplace() {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    setRetrySucceeded(false);
    try {
      await resolveConflict(conflictId, "RetryLocalToMarketplace");
      setRetrySucceeded(true);
      router.refresh();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to retry to marketplace");
    } finally {
      setBusy(false);
    }
  }

  if (!eligible) return null;

  return (
    <section>
      <h2>Resolve</h2>
      <ConfirmButton
        label="Mark Resolved"
        eligible={eligible}
        blockedByOther={busy}
        onBusyChange={setBusy}
        onSuccess={() => router.refresh()}
        run={() => resolveConflict(conflictId, "MarkResolved").then(() => {})}
      />
      <ConfirmButton
        label="Ignore"
        eligible={eligible}
        blockedByOther={busy}
        onBusyChange={setBusy}
        onSuccess={() => router.refresh()}
        run={() => resolveConflict(conflictId, "Ignore").then(() => {})}
      />
      <span style={{ display: "inline-block" }}>
        <button disabled={busy} style={buttonStyle} onClick={handleRetryToMarketplace}>{busy ? "Retrying…" : "Retry to Marketplace"}</button>
        {retryError && <p role="alert" style={{ color: "#c86a6a" }}>{retryError}</p>}
        {retrySucceeded && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Retry to marketplace triggered.</p>}
      </span>
    </section>
  );
}
