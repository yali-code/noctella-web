"use client";

import {
  AiIntakeFieldDecision,
  AiProductIntakeStatus,
  type AiIntakePhoto,
  type AiIntakeProposalReview,
  type AiIntakeReviewedField,
} from "@noctella/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";

type FieldName = "title" | "description" | "keywords";

interface Props {
  intakeId: string;
  intakeStatus: AiProductIntakeStatus;
  photos: AiIntakePhoto[];
  proposal: AiIntakeProposalReview | null;
  onProposalChanged: (proposal: AiIntakeProposalReview) => void;
  onProposalReload: () => Promise<AiIntakeProposalReview | null>;
}

function formatValue(value: string | string[] | null): string {
  if (value === null) return "—";
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Sprint 97: proposal generation/regeneration and per-field review (Accept/
 * Edit/Reject/Reset to Pending). Every successful PATCH replaces the entire
 * proposal object via onProposalChanged (never merged locally) - the next
 * mutation's expectedUpdatedAt always comes from that latest object. On a
 * 409 (stale or version conflict), shows an explicit reload prompt and never
 * auto-resubmits.
 */
export function ProposalReviewSection({ intakeId, intakeStatus, photos, proposal, onProposalChanged, onProposalReload }: Props) {
  const [generating, setGenerating] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<FieldName | null>(null);
  const [editingField, setEditingField] = useState<FieldName | null>(null);
  const [editValue, setEditValue] = useState("");

  /**
   * Sprint 99: resets local edit-in-progress state (editingField/editValue) only when the
   * incoming proposal is genuinely a different version - identified by id+updatedAt, the most
   * stable identity available, never by object reference alone (a parent re-render passing the
   * same proposal content must not interrupt an in-progress edit). Never auto-submits, auto-
   * retries, or silently keeps editing against a proposal that no longer exists - it only clears
   * local state; the backend's own expectedUpdatedAt check is unchanged and unaffected.
   */
  const proposalVersionKey = proposal ? `${proposal.id}:${proposal.updatedAt}` : null;
  const lastProposalVersionKeyRef = useRef<string | null>(proposalVersionKey);
  useEffect(() => {
    if (lastProposalVersionKeyRef.current !== proposalVersionKey) {
      lastProposalVersionKeyRef.current = proposalVersionKey;
      setEditingField(null);
      setEditValue("");
    }
  }, [proposalVersionKey]);

  const isOpen = intakeStatus === AiProductIntakeStatus.Open;
  const stale = proposal?.stale === true;
  const allPending =
    proposal !== null &&
    [proposal.title, proposal.description, proposal.keywords].every((f) => f.decision === AiIntakeFieldDecision.Pending);

  async function reloadThenClearConflict() {
    setConflict(null);
    await onProposalReload();
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const generated = await aiProductIntakesApi.generateProposal(intakeId);
      onProposalChanged(generated);
      setConfirmRegenerate(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate proposal");
    } finally {
      setGenerating(false);
    }
  }

  async function submitDecision(field: FieldName, decision: AiIntakeFieldDecision, value?: string | string[]) {
    if (!proposal) return;
    setBusyField(field);
    setError(null);
    try {
      const updated = await aiProductIntakesApi.updateFieldReview(intakeId, field, decision, proposal.updatedAt, value);
      onProposalChanged(updated);
      setEditingField(null);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "AI_INTAKE_PROPOSAL_STALE" || err.code === "AI_INTAKE_PROPOSAL_VERSION_CONFLICT")) {
        setConflict(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to update field review");
      }
    } finally {
      setBusyField(null);
    }
  }

  function startEdit(field: FieldName, reviewed: AiIntakeReviewedField<string> | AiIntakeReviewedField<string[]>) {
    setEditingField(field);
    const current = reviewed.value ?? reviewed.suggestion;
    setEditValue(Array.isArray(current) ? current.join(", ") : current ?? "");
  }

  function submitEdit(field: FieldName) {
    if (field === "keywords") {
      const list = editValue.split(",").map((k) => k.trim()).filter(Boolean);
      if (list.length === 0) return;
      submitDecision(field, AiIntakeFieldDecision.Edited, list);
    } else {
      if (!editValue.trim()) return;
      submitDecision(field, AiIntakeFieldDecision.Edited, editValue.trim());
    }
  }

  return (
    <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Proposal Review</h3>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {conflict && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ color: "#c86a6a" }}>{conflict}</p>
          <button onClick={reloadThenClearConflict} style={secondaryButtonStyle}>
            Reload
          </button>
        </div>
      )}

      {isOpen && photos.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
          No staged photos yet - the generated result may be less useful without them.
        </p>
      )}

      {!proposal && isOpen && (
        <button onClick={handleGenerate} disabled={generating} style={primaryButtonStyle}>
          {generating ? "Generating..." : "Generate"}
        </button>
      )}

      {proposal && (
        <>
          {stale && (
            <p style={{ fontSize: 12, color: "#c86a6a", marginBottom: 12 }}>
              The staged photos changed after this proposal was generated. Accept, Edit, and Reject are unavailable until every field is
              reset to Pending and the proposal is regenerated.
            </p>
          )}

          <FieldReviewRow
            label="Title"
            field="title"
            reviewed={proposal.title}
            stale={stale}
            canReview={isOpen}
            busy={busyField === "title"}
            editing={editingField === "title"}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onStartEdit={() => startEdit("title", proposal.title)}
            onCancelEdit={() => setEditingField(null)}
            onSubmitEdit={() => submitEdit("title")}
            onAccept={() => submitDecision("title", AiIntakeFieldDecision.Accepted)}
            onReject={() => submitDecision("title", AiIntakeFieldDecision.Rejected)}
            onReset={() => submitDecision("title", AiIntakeFieldDecision.Pending)}
          />
          <FieldReviewRow
            label="Description"
            field="description"
            reviewed={proposal.description}
            stale={stale}
            canReview={isOpen}
            busy={busyField === "description"}
            editing={editingField === "description"}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onStartEdit={() => startEdit("description", proposal.description)}
            onCancelEdit={() => setEditingField(null)}
            onSubmitEdit={() => submitEdit("description")}
            onAccept={() => submitDecision("description", AiIntakeFieldDecision.Accepted)}
            onReject={() => submitDecision("description", AiIntakeFieldDecision.Rejected)}
            onReset={() => submitDecision("description", AiIntakeFieldDecision.Pending)}
          />
          <FieldReviewRow
            label="Keywords"
            field="keywords"
            reviewed={proposal.keywords}
            stale={stale}
            canReview={isOpen}
            busy={busyField === "keywords"}
            editing={editingField === "keywords"}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onStartEdit={() => startEdit("keywords", proposal.keywords)}
            onCancelEdit={() => setEditingField(null)}
            onSubmitEdit={() => submitEdit("keywords")}
            onAccept={() => submitDecision("keywords", AiIntakeFieldDecision.Accepted)}
            onReject={() => submitDecision("keywords", AiIntakeFieldDecision.Rejected)}
            onReset={() => submitDecision("keywords", AiIntakeFieldDecision.Pending)}
          />

          {isOpen &&
            (confirmRegenerate ? (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 12 }}>Regenerate the proposal? This replaces the current suggestions.</p>
                <button onClick={handleGenerate} disabled={generating || !allPending} style={primaryButtonStyle}>
                  {generating ? "Regenerating..." : "Confirm Regenerate"}
                </button>{" "}
                <button onClick={() => setConfirmRegenerate(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmRegenerate(true)} disabled={!allPending} style={{ ...secondaryButtonStyle, marginTop: 12 }}>
                Regenerate
              </button>
            ))}
          {isOpen && !allPending && (
            <p style={{ fontSize: 11, color: "var(--noctella-aged-bronze)" }}>
              Regeneration requires every field to be reset to Pending first.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FieldReviewRow(props: {
  label: string;
  field: FieldName;
  reviewed: AiIntakeReviewedField<string> | AiIntakeReviewedField<string[]>;
  stale: boolean;
  /** Sprint 97 correction (M1): the intake is Open - proposal review writes are rejected by the
   * API for every other status, so mutation controls are only ever enabled here too. Content
   * (suggestion/decision/value) remains visible regardless. */
  canReview: boolean;
  busy: boolean;
  editing: boolean;
  editValue: string;
  onEditValueChange: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: () => void;
  onAccept: () => void;
  onReject: () => void;
  onReset: () => void;
}) {
  const { label, reviewed, stale, canReview, busy, editing, editValue, onEditValueChange, onStartEdit, onCancelEdit, onSubmitEdit, onAccept, onReject, onReset } =
    props;
  const isPending = reviewed.decision === AiIntakeFieldDecision.Pending;
  return (
    <div style={{ marginBottom: 16, borderTop: "1px solid rgba(122,106,79,0.3)", paddingTop: 12 }}>
      <strong>{label}</strong>
      <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Suggestion: {formatValue(reviewed.suggestion)}</p>
      <p style={{ fontSize: 12 }}>
        Decision: {reviewed.decision}
        {reviewed.value !== null ? ` — ${formatValue(reviewed.value)}` : ""}
      </p>
      {editing ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={editValue} onChange={(e) => onEditValueChange(e.target.value)} style={inputStyle} />
          <button onClick={onSubmitEdit} disabled={busy || !editValue.trim()} style={primaryButtonStyle}>
            Save Edit
          </button>
          <button onClick={onCancelEdit} style={secondaryButtonStyle}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onAccept} disabled={!canReview || stale || busy} style={secondaryButtonStyle}>
            Accept
          </button>
          <button onClick={onStartEdit} disabled={!canReview || stale || busy} style={secondaryButtonStyle}>
            Edit
          </button>
          <button onClick={onReject} disabled={!canReview || stale || busy} style={secondaryButtonStyle}>
            Reject
          </button>
          <button onClick={onReset} disabled={!canReview || isPending || busy} style={secondaryButtonStyle}>
            Reset to Pending
          </button>
        </div>
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
  flex: 1,
};

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
  padding: "6px 10px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  cursor: "pointer",
};
