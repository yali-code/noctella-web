"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelBackgroundJob, retryBackgroundJob } from "@/lib/stockSyncJobs";
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

/**
 * Retry has no confirmation step (matches the existing publish-job retry precedent,
 * apps/admin/src/app/publish-jobs/[id]/page.tsx). Cancel is destructive-adjacent (stops an
 * in-flight/queued job) and uses the shared ConfirmButton two-step confirm.
 */
export function JobActions({ jobId, canRetry, canCancel }: { jobId: string; canRetry: boolean; canCancel: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySucceeded, setRetrySucceeded] = useState(false);

  async function handleRetry() {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    setRetrySucceeded(false);
    try {
      await retryBackgroundJob(jobId);
      setRetrySucceeded(true);
      router.refresh();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to retry job");
    } finally {
      setBusy(false);
    }
  }

  if (!canRetry && !canCancel) return null;

  return (
    <section>
      <h2>Actions</h2>
      {canRetry && (
        <span style={{ display: "inline-block", marginRight: 8 }}>
          <button disabled={busy} style={buttonStyle} onClick={handleRetry}>{busy ? "Retrying…" : "Retry"}</button>
          {retryError && <p role="alert" style={{ color: "#c86a6a" }}>{retryError}</p>}
          {retrySucceeded && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Retry succeeded.</p>}
        </span>
      )}
      <ConfirmButton
        label="Cancel"
        eligible={canCancel}
        blockedByOther={busy}
        onBusyChange={setBusy}
        onSuccess={() => router.refresh()}
        run={() => cancelBackgroundJob(jobId).then(() => {})}
      />
    </section>
  );
}
