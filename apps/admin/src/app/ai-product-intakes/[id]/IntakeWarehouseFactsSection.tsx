"use client";

import { AiProductIntakeStatus, PRODUCT_CONDITION_VALUES, type AiProductIntake } from "@noctella/shared";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";

interface Props {
  intake: AiProductIntake;
  hasProposal: boolean;
  onIntakeChanged: () => Promise<unknown>;
}

/** Warehouse-declared condition and test note, captured before AI generation. */
export function IntakeWarehouseFactsSection({ intake, hasProposal, onIntakeChanged }: Props) {
  const [condition, setCondition] = useState(intake.declaredCondition ?? "");
  const [testNote, setTestNote] = useState(intake.testNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAfterProposal, setSavedAfterProposal] = useState(false);

  useEffect(() => {
    setCondition(intake.declaredCondition ?? "");
    setTestNote(intake.testNote ?? "");
  }, [intake.declaredCondition, intake.testNote]);

  const locked = intake.status !== AiProductIntakeStatus.Open;
  const dirty = condition !== (intake.declaredCondition ?? "") || testNote.trim() !== (intake.testNote ?? "");

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await aiProductIntakesApi.updateWarehouseFacts(intake.id, { declaredCondition: condition, testNote: testNote.trim() || null });
      await onIntakeChanged();
      setSavedAfterProposal(hasProposal);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save warehouse details");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Warehouse Check</h3>
      <label style={{ display: "block", marginBottom: 12 }}>
        Condition (required)
        <select value={condition} onChange={(e) => setCondition(e.target.value)} disabled={locked} style={{ display: "block", width: "100%", marginTop: 4 }}>
          <option value="">Select condition</option>
          {PRODUCT_CONDITION_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "block", marginBottom: 12 }}>
        Test note
        <textarea value={testNote} onChange={(e) => setTestNote(e.target.value)} disabled={locked} maxLength={2000} rows={3} style={{ display: "block", width: "100%", marginTop: 4 }} />
      </label>
      {!locked && (
        <button onClick={handleSave} disabled={saving || !condition || !dirty}>
          {saving ? "Saving..." : "Save warehouse check"}
        </button>
      )}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {savedAfterProposal && !dirty && <p>Saved. Regenerate the proposal so the AI uses these details.</p>}
    </div>
  );
}
