"use client";

import { useState } from "react";
import {
  formatEur,
  invoiceIntakeApi,
  type CostSetPreview,
  type CostSetProductCandidate,
  type InvoiceCostSetDetail,
  type InvoiceCostSetItem,
  type InvoiceIntake,
} from "@/lib/invoiceIntakes";

/**
 * PHASE-2C: bank debit + official ECB rate per reviewed invoice, product selection with value weights, the
 * allocation preview, and approve -> Draft purchase. All amounts are computed by the API; this UI only shows them.
 */
const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 13,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer", marginRight: 6 };
const cell: React.CSSProperties = { padding: "2px 6px", textAlign: "right" };
const issueStyle: React.CSSProperties = { color: "#c86a6a", margin: "2px 0" };
const warningStyle: React.CSSProperties = { color: "#d9a441", margin: "2px 0" };
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export function BankDebitForm({ intake, editable, onSaved }: { intake: InvoiceIntake; editable: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(intake.bankDebitEur == null ? "" : String(intake.bankDebitEur));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = intake.invoiceNumber ?? intake.originalFilenameSanitized ?? intake.id;

  async function save() {
    const amount = Number(value);
    if (!value.trim() || !Number.isFinite(amount) || amount <= 0) { setError("Enter the bank debit in EUR (above 0)"); return; }
    setBusy(true);
    setError(null);
    try {
      await invoiceIntakeApi.setBankDebit(intake.id, amount);
      onSaved();
    } catch (err) {
      setError(errorText(err, "Failed to get the official rate"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label={`Bank debit ${label}`} style={{ margin: "6px 0" }}>
      <strong>{intake.invoiceType} {label}</strong>{" "}
      <span>{intake.totalOriginal ?? "—"} {intake.currency ?? ""}, paid {intake.paidDate ?? "—"}</span>
      {editable && (
        <div>
          <label>
            Bank debit (EUR){" "}
            <input style={inputStyle} type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>{" "}
          <button style={buttonStyle} disabled={busy} onClick={save}>{busy ? "Getting rate…" : "Save & get official rate"}</button>
        </div>
      )}
      {intake.fxRate != null && (
        <p style={{ margin: "2px 0", fontSize: 12 }}>
          {intake.fxSource} rate {intake.fxRate} ({intake.fxRateDate}) · official {formatEur(intake.fx?.officialEur)} EUR · bank {formatEur(intake.bankDebitEur)} EUR · FX difference {formatEur(intake.fx?.fxDiffEur)} EUR
        </p>
      )}
      {intake.fxRate == null && intake.bankDebitEur != null && <p style={warningStyle}>Bank debit {formatEur(intake.bankDebitEur)} EUR saved; the official rate is missing - save again to fetch it.</p>}
      {error && <p role="alert" style={issueStyle}>{error}</p>}
    </div>
  );
}

interface Row { productId: string; sku: string | null; title: string | null; aiSuggestedPriceEur: number | null; weight: string; source: InvoiceCostSetItem["weightSource"] }
const SOURCE_LABELS = { ai: "AI", admin: "admin", fallback: "fallback (average)" } as const;
const toRow = (i: InvoiceCostSetItem): Row => ({ productId: i.productId, sku: i.sku, title: i.title, aiSuggestedPriceEur: i.aiSuggestedPriceEur, weight: i.valueWeightEur == null ? "" : String(i.valueWeightEur), source: i.weightSource });

export function CostSetAllocationPanel({ costSet, onChanged }: { costSet: InvoiceCostSetDetail; onChanged: () => void }) {
  const open = costSet.status === "open";
  const [rows, setRows] = useState<Row[]>((costSet.items ?? []).map(toRow));
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CostSetProductCandidate[] | null>(null);
  const [preview, setPreview] = useState<CostSetPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [approvedPurchaseId, setApprovedPurchaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); } catch (err) { setError(errorText(err, fallback)); } finally { setBusy(false); }
  }

  const search = () => run(async () => { setCandidates((await invoiceIntakeApi.productCandidates(costSet.id, query.trim())).items); }, "Failed to search products");

  function add(c: CostSetProductCandidate) {
    if (rows.some((r) => r.productId === c.productId)) return;
    setRows([...rows, { productId: c.productId, sku: c.sku, title: c.title, aiSuggestedPriceEur: c.aiSuggestedPriceEur, weight: c.aiSuggestedPriceEur == null ? "" : String(c.aiSuggestedPriceEur), source: c.aiSuggestedPriceEur == null ? null : "ai" }]);
    setDirty(true);
    setPreview(null);
  }
  function remove(productId: string) { setRows(rows.filter((r) => r.productId !== productId)); setDirty(true); setPreview(null); }
  function editWeight(productId: string, weight: string) { setRows(rows.map((r) => (r.productId === productId ? { ...r, weight, source: "admin" } : r))); setDirty(true); setPreview(null); }

  const saveProducts = () => run(async () => {
    const items = rows.map((r) => (r.source === "admin" ? { productId: r.productId, valueWeightEur: r.weight.trim() === "" ? null : Number(r.weight) } : { productId: r.productId }));
    if (items.some((i) => "valueWeightEur" in i && i.valueWeightEur != null && !(Number.isFinite(i.valueWeightEur) && i.valueWeightEur > 0))) throw new Error("A weight must be a number above 0");
    const saved = await invoiceIntakeApi.setProducts(costSet.id, items);
    setRows(saved.items.map(toRow));
    setDirty(false);
    setPreview(null);
  }, "Failed to save products");

  const runPreview = () => run(async () => { setConfirming(false); setPreview(await invoiceIntakeApi.preview(costSet.id)); }, "Failed to preview the allocation");

  const approve = () => run(async () => {
    const result = await invoiceIntakeApi.approve(costSet.id);
    setConfirming(false);
    setApprovedPurchaseId(result.purchaseId);
    onChanged();
  }, "Failed to approve the cost set");

  const purchaseId = approvedPurchaseId ?? costSet.purchaseId;
  const canApprove = open && !dirty && !!preview && preview.issues.length === 0 && preview.items.length > 0 && !purchaseId;
  const selectedIds = new Set(rows.map((r) => r.productId));

  return (
    <section aria-label="Products and allocation" style={{ marginTop: 16 }}>
      <h2>Products</h2>
      {rows.length === 0 && <p>No products selected.</p>}
      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left" }}><th>SKU</th><th>Title</th><th>AI estimate (EUR)</th><th>Weight (EUR)</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId}>
                <td>{r.sku}</td>
                <td>{r.title}</td>
                <td>{formatEur(r.aiSuggestedPriceEur)}</td>
                <td>
                  {open
                    ? <input aria-label={`Weight ${r.sku}`} style={inputStyle} type="number" step="0.01" min="0" value={r.weight} onChange={(e) => editWeight(r.productId, e.target.value)} />
                    : r.weight || "—"}
                </td>
                <td>{r.source ? SOURCE_LABELS[r.source] : "fallback (on save)"}</td>
                <td>{open && <button style={buttonStyle} disabled={busy} onClick={() => remove(r.productId)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && <p style={{ margin: "4px 0", fontSize: 12 }}>Items without an AI estimate use the average of the AI estimates in this set; edit any value to override.</p>}

      {open && (
        <div style={{ marginTop: 8 }}>
          <button style={buttonStyle} disabled={busy || !dirty} onClick={saveProducts}>Save products</button>
          {dirty && <span style={warningStyle}>Unsaved changes</span>}
          <div style={{ marginTop: 8 }}>
            <label>
              Find product{" "}
              <input style={inputStyle} placeholder="SKU or title" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
            </label>{" "}
            <button style={buttonStyle} disabled={busy} onClick={search}>Search</button>
          </div>
          {candidates && candidates.length === 0 && <p>No matching products.</p>}
          {candidates && candidates.length > 0 && (
            <table aria-label="Product candidates" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
              <thead><tr style={{ textAlign: "left" }}><th>SKU</th><th>Title</th><th>Created</th><th>AI estimate (EUR)</th><th></th></tr></thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.productId}>
                    <td>{c.sku}</td><td>{c.title}</td><td>{new Date(c.createdAt).toLocaleDateString()}</td><td>{formatEur(c.aiSuggestedPriceEur)}</td>
                    <td><button style={buttonStyle} disabled={selectedIds.has(c.productId)} onClick={() => add(c)}>{selectedIds.has(c.productId) ? "Added" : "Add"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h2>Allocation</h2>
      {open && <button style={buttonStyle} disabled={busy || dirty} onClick={runPreview}>Preview allocation</button>}
      {error && <p role="alert" style={issueStyle}>{error}</p>}
      {preview && (
        <div>
          {preview.issues.map((i, k) => <p key={`i${k}`} data-testid="allocation-issue" style={issueStyle}>{i.message}</p>)}
          {preview.warnings.map((w, k) => <p key={`w${k}`} data-testid="allocation-warning" style={warningStyle}>{w.message}</p>)}
          {preview.intakes.map((i) => (
            <p key={i.intakeId} style={{ margin: "2px 0", fontSize: 12 }}>
              {i.invoiceType} {i.invoiceNumber}: {i.totalOriginal} {i.currency} @ {i.fxSource} {i.fxRate} ({i.fxRateDate}) = official {formatEur(i.officialEur)} · bank {formatEur(i.bankDebitEur)} · FX diff {formatEur(i.fxDiffEur)} EUR
            </p>
          ))}
          {preview.items.length > 0 && <AllocationTable rows={preview.items.map((i) => ({ key: i.productId, sku: i.sku, title: i.title, values: [i.lotEur, i.hammerFeeEur, i.premiumEur, i.transportEur, i.forwarderEur, i.fxDiffEur, i.totalEur] }))} totalBankDebitEur={preview.totalBankDebitEur} />}
        </div>
      )}
      {!open && !preview && (costSet.items ?? []).some((i) => i.allocTotalEur != null) && (
        <AllocationTable rows={(costSet.items ?? []).map((i) => ({ key: i.productId, sku: i.sku, title: i.title, values: [i.allocLotEur ?? 0, i.allocHammerFeeEur ?? 0, i.allocPremiumEur ?? 0, i.allocTransportEur ?? 0, i.allocForwarderEur ?? 0, i.allocFxDiffEur ?? 0, i.allocTotalEur ?? 0] }))} totalBankDebitEur={null} />
      )}

      {open && !purchaseId && (
        <div style={{ marginTop: 8 }}>
          {!confirming && <button style={buttonStyle} disabled={busy || !canApprove} onClick={() => setConfirming(true)}>Approve & create purchase</button>}
          {confirming && preview && (
            <div role="group" aria-label="Confirm approve">
              <p>Create a Draft purchase with {preview.items.length} line(s) totalling {formatEur(preview.totalAllocatedEur)} EUR? The cost set and its invoices become read-only. Stock is not changed.</p>
              <button style={buttonStyle} disabled={busy} onClick={approve}>{busy ? "Approving…" : "Confirm approve"}</button>
              <button style={buttonStyle} disabled={busy} onClick={() => setConfirming(false)}>Back</button>
            </div>
          )}
        </div>
      )}
      {purchaseId && <p>Draft purchase: <a href={`/purchases/${encodeURIComponent(purchaseId)}`}>{`/purchases/${purchaseId}`}</a></p>}
    </section>
  );
}

const COLUMNS = ["Lot", "Hammer", "Premium", "Transport", "Forwarder", "FX diff", "Total"];

function AllocationTable({ rows, totalBankDebitEur }: { rows: Array<{ key: string; sku: string | null; title: string | null; values: number[] }>; totalBankDebitEur: number | null }) {
  const sums = COLUMNS.map((_, c) => rows.reduce((a, r) => a + Math.round(r.values[c] * 100), 0) / 100);
  return (
    <table aria-label="Allocation preview" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
      <thead><tr><th style={{ textAlign: "left" }}>SKU</th><th style={{ textAlign: "left" }}>Title</th>{COLUMNS.map((c) => <th key={c} style={cell}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}><td>{r.sku}</td><td>{r.title}</td>{r.values.map((v, k) => <td key={k} style={cell}>{formatEur(v)}</td>)}</tr>
        ))}
        <tr data-testid="allocation-totals" style={{ fontWeight: 600 }}>
          <td>Total</td><td>{totalBankDebitEur != null ? `bank debits ${formatEur(totalBankDebitEur)}` : ""}</td>
          {sums.map((v, k) => <td key={k} style={cell}>{formatEur(v)}</td>)}
        </tr>
      </tbody>
    </table>
  );
}
