"use client";

import { useState } from "react";
import { executeMerge, searchMergeCandidates, type MergeCandidateSearch } from "../../../lib/erpCustomerBridge";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

type Candidate = { customer: { id: string; name?: string; email?: string; phone?: string; erpReferenceId?: string; marketplaceBuyerId?: string }; reasons: string[] };

const emptySearch: MergeCandidateSearch = { email: "", phone: "", vatNumber: "", erpReferenceId: "", marketplaceBuyerId: "" };

export default function CustomerMergePage() {
  const [form, setForm] = useState<MergeCandidateSearch>(emptySearch);
  const [lastCriteria, setLastCriteria] = useState<MergeCandidateSearch | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<{ status: string; idempotent: boolean; sourceCustomerId: string; targetCustomerId: string } | null>(null);

  function resetMergeAttempt() {
    setArmed(false);
    setMergeKey(null);
    setMergeError(null);
    setMergeResult(null);
  }

  function toCriteria(f: MergeCandidateSearch): MergeCandidateSearch {
    const c: MergeCandidateSearch = {};
    if (f.email) c.email = f.email;
    if (f.phone) c.phone = f.phone;
    if (f.vatNumber) c.vatNumber = f.vatNumber;
    if (f.erpReferenceId) c.erpReferenceId = f.erpReferenceId;
    if (f.marketplaceBuyerId) c.marketplaceBuyerId = f.marketplaceBuyerId;
    return c;
  }

  async function runSearch(criteria: MergeCandidateSearch) {
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchMergeCandidates(criteria);
      setCandidates(result.candidates ?? []);
      setLastCriteria(criteria);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Failed to search for merge candidates");
    } finally {
      setSearching(false);
    }
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (searching) return;
    setSourceId(null);
    setTargetId(null);
    resetMergeAttempt();
    await runSearch(toCriteria(form));
  }

  function selectRole(customerId: string, role: "source" | "target") {
    if (role === "source") setSourceId((prev) => (prev === customerId ? null : customerId));
    else setTargetId((prev) => (prev === customerId ? null : customerId));
    resetMergeAttempt();
  }

  function armMerge() {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setArmed(true);
    setMergeKey(crypto.randomUUID());
    setMergeError(null);
    setMergeResult(null);
  }

  async function confirmMerge() {
    if (merging || !armed || !mergeKey || !sourceId || !targetId) return;
    setMerging(true);
    setMergeError(null);
    try {
      const result = await executeMerge({ sourceCustomerId: sourceId, targetCustomerId: targetId, idempotencyKey: mergeKey });
      setMergeResult(result);
      setArmed(false);
      setMergeKey(null);
      if (lastCriteria) await runSearch(lastCriteria);
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Failed to execute merge");
    } finally {
      setMerging(false);
    }
  }

  const canArm = Boolean(sourceId && targetId && sourceId !== targetId);

  return (
    <main>
      <h1>Customer Merge</h1>
      <p>Duplicate detection covers ERP reference, marketplace buyer ID, email, phone, VAT number, shipping address and billing address.</p>
      <p>Never merge automatically; explicit execution through the ERP Integration API is required.</p>

      <section>
        <h2>Find Duplicate Candidates</h2>
        <form onSubmit={handleSearchSubmit}>
          <input style={inputStyle} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input style={inputStyle} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input style={inputStyle} placeholder="VAT number" value={form.vatNumber} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} />
          <input style={inputStyle} placeholder="ERP reference" value={form.erpReferenceId} onChange={(e) => setForm({ ...form, erpReferenceId: e.target.value })} />
          <input style={inputStyle} placeholder="Marketplace buyer ID" value={form.marketplaceBuyerId} onChange={(e) => setForm({ ...form, marketplaceBuyerId: e.target.value })} />
          <button type="submit" style={buttonStyle} disabled={searching}>{searching ? "Searching…" : "Search"}</button>
        </form>
        {searchError && <p role="alert" style={{ color: "#c86a6a" }}>{searchError}</p>}
      </section>

      {candidates && (
        <section>
          <h2>Candidates</h2>
          {candidates.length === 0 ? (
            <p>No matching candidates found.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Match reasons</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((cand) => {
                  const c = cand.customer;
                  const role = c.id === sourceId ? "Source" : c.id === targetId ? "Target" : null;
                  return (
                    <tr key={c.id}>
                      <td>{c.name ?? "Unnamed"} ({c.id})</td>
                      <td>{c.email ?? "—"}</td>
                      <td>{cand.reasons.join(", ")}</td>
                      <td>
                        <button style={buttonStyle} disabled={merging} onClick={() => selectRole(c.id, "source")}>{c.id === sourceId ? "Unset Source" : "Set as Source"}</button>
                        <button style={buttonStyle} disabled={merging} onClick={() => selectRole(c.id, "target")}>{c.id === targetId ? "Unset Target" : "Set as Target"}</button>
                        {role && <span style={{ marginLeft: 6 }}>{role}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section>
        <h2>Execute Merge</h2>
        <p>Source: {sourceId ?? "none selected"} → Target: {targetId ?? "none selected"}</p>
        {!armed ? (
          <button style={buttonStyle} disabled={!canArm} onClick={armMerge}>Merge</button>
        ) : (
          <div>
            <p>Confirm merging {sourceId} into {targetId}. This cannot be undone from this screen.</p>
            <button style={buttonStyle} disabled={merging} onClick={confirmMerge}>{merging ? "Merging…" : "Confirm Merge"}</button>
            <button style={buttonStyle} disabled={merging} onClick={resetMergeAttempt}>Cancel</button>
          </div>
        )}
        {mergeError && <p role="alert" style={{ color: "#c86a6a" }}>{mergeError}</p>}
        {mergeResult && (
          <p style={{ color: "var(--noctella-bright-star-gold)" }}>
            {mergeResult.idempotent
              ? `Merge already completed for this request (idempotent replay): ${mergeResult.sourceCustomerId} → ${mergeResult.targetCustomerId}.`
              : `Merge completed: ${mergeResult.sourceCustomerId} → ${mergeResult.targetCustomerId}.`}
          </p>
        )}
      </section>
    </main>
  );
}
