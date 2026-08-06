"use client";

import { AiProductIntakeStatus, type AiProductIntake } from "@noctella/shared";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";

interface Props {
  intakeId: string;
  intakeStatus: AiProductIntakeStatus;
  onIntakeChanged: () => Promise<AiProductIntake>;
}

/** Sprint 97: cancellation - only available while Open, terminal, explicit inline confirmation. */
export function IntakeDangerZone({ intakeId, intakeStatus, onIntakeChanged }: Props) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (intakeStatus !== AiProductIntakeStatus.Open) return null;

  async function handleCancel() {
    setCancelling(true);
    setError(null);
    try {
      await aiProductIntakesApi.cancel(intakeId, reason.trim() || undefined);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cancel intake");
    } finally {
      setCancelling(false);
      await onIntakeChanged();
    }
  }

  return (
    <div className="noctella-panel" style={{ padding: 20, borderColor: "#c86a6a" }}>
      <h3 style={{ marginTop: 0 }}>Danger Zone</h3>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {confirming ? (
        <div>
          <input
            placeholder="Cancellation reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={inputStyle}
          />
          <p style={{ fontSize: 12, marginTop: 8 }}>Cancel this intake? This is terminal and cannot be undone.</p>
          <button onClick={handleCancel} disabled={cancelling} style={dangerButtonStyle}>
            {cancelling ? "Cancelling..." : "Confirm Cancel"}
          </button>{" "}
          <button onClick={() => setConfirming(false)} style={secondaryButtonStyle}>
            Back
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} style={dangerButtonStyle}>
          Cancel Intake
        </button>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
  maxWidth: 360,
};

const dangerButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "#c86a6a",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  cursor: "pointer",
};
