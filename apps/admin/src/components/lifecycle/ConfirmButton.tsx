"use client";

import { useState } from "react";
import { isConcurrencyConflict } from "@/lib/returns";

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
 * Shared confirm-then-run action control for return/refund lifecycle transitions (Sprint 56B).
 * `eligible` hides the action entirely (mirrors the backend's own transition guard rather than
 * a client-side guess). `blockedByOther` disables it while a sibling action on the same record
 * is in flight, since two lifecycle transitions must never be submitted concurrently.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  pendingLabel,
  eligible,
  blockedByOther,
  run,
  onSuccess,
  onBusyChange,
  children,
}: {
  label: string;
  confirmLabel?: string;
  pendingLabel?: string;
  eligible: boolean;
  blockedByOther?: boolean;
  run: () => Promise<void>;
  onSuccess?: () => void;
  onBusyChange?: (busy: boolean) => void;
  children?: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  if (!eligible) return null;

  async function handleConfirm() {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      await run();
      setSucceeded(true);
      setArmed(false);
      onSuccess?.();
    } catch (e) {
      setSucceeded(false);
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <span style={{ display: "inline-block" }}>
      {!armed ? (
        <button
          disabled={blockedByOther}
          onClick={() => {
            setArmed(true);
            setSucceeded(false);
            setError(null);
          }}
          style={buttonStyle}
        >
          {label}
        </button>
      ) : (
        <div style={{ marginTop: 6 }}>
          {children}
          <button disabled={busy || blockedByOther} onClick={handleConfirm} style={buttonStyle}>
            {busy ? (pendingLabel ?? "Submitting…") : (confirmLabel ?? `Confirm ${label}`)}
          </button>
          <button disabled={busy} onClick={() => { setArmed(false); setError(null); }} style={buttonStyle}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: "#c86a6a" }}>
          {isConcurrencyConflict(error)
            ? `Concurrency conflict: this record changed before your request reached the server. ${error}`
            : error}
        </p>
      )}
      {succeeded && <p style={{ color: "var(--noctella-bright-star-gold)" }}>{label} succeeded.</p>}
    </span>
  );
}
