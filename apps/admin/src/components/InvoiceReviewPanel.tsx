"use client";

import { useState } from "react";
import {
  hasTotalMismatch,
  INVOICE_FEE_TYPES,
  INVOICE_TYPES,
  invoiceIntakeApi,
  LOW_CONFIDENCE,
  type ExtractedField,
  type InvoiceFeeValues,
  type InvoiceHeaderField,
  type InvoiceIntake,
  type InvoiceIntakeReview,
  type InvoiceLotValues,
  type InvoiceValues,
} from "@/lib/invoiceIntakes";

/**
 * PHASE-2B: review/edit form for one AI-read invoice. Shows the model's evidence under each field and highlights
 * low-confidence values. Only fields that differ from the AI values are sent as edits; the checks are computed by
 * the API (the confirm button follows the last saved checks, and the API refuses a confirm with TOTAL_MISMATCH).
 */
const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 13,
};
const lowStyle: React.CSSProperties = { ...inputStyle, border: "2px solid #d9a441" };
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer", marginRight: 6 };
const evidenceStyle: React.CSSProperties = { fontSize: 11, color: "var(--noctella-aged-bronze)", margin: "2px 0 0" };

type Kind = "text" | "number" | "date" | "currency" | "boolean" | "type";
const HEADER_FIELDS: Array<{ name: InvoiceHeaderField; label: string; kind: Kind }> = [
  { name: "invoiceType", label: "Invoice type", kind: "type" },
  { name: "supplierName", label: "Supplier", kind: "text" },
  { name: "supplierVatNumber", label: "Supplier VAT number", kind: "text" },
  { name: "platform", label: "Platform", kind: "text" },
  { name: "invoiceNumber", label: "Invoice number", kind: "text" },
  { name: "issueDate", label: "Issue date", kind: "date" },
  { name: "dueDate", label: "Due date", kind: "date" },
  { name: "paidDate", label: "Paid date", kind: "date" },
  { name: "currency", label: "Currency", kind: "currency" },
  { name: "vatNote", label: "VAT note", kind: "text" },
  { name: "reverseCharge", label: "Reverse charge / no VAT", kind: "boolean" },
  { name: "total", label: "Total", kind: "number" },
];

type Row = Record<string, string>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const toText = (s: string) => (s.trim() === "" ? null : s.trim());
const toNumber = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

function fromForm(kind: Kind, s: string): unknown {
  if (kind === "number") return toNumber(s);
  if (kind === "boolean") return s === "" ? null : s === "true";
  if (kind === "currency") return toText(s.toUpperCase());
  return toText(s);
}
const lotFromRow = (r: Row): InvoiceLotValues => ({ lotNumber: toText(r.lotNumber), title: toText(r.title), itemCountHint: toNumber(r.itemCountHint), amount: toNumber(r.amount) });
const feeFromRow = (r: Row): InvoiceFeeValues => ({ type: (toText(r.type) as InvoiceFeeValues["type"]), label: toText(r.label), amount: toNumber(r.amount), percent: toNumber(r.percent), lotNumber: toText(r.lotNumber) });
const toRow = (o: object): Row => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(v)]));
const plain = (rows: Array<Record<string, ExtractedField<unknown>>>) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, f]) => [k, f.value])));

/** The edits to send: every field whose form value differs from the AI value; lots/fees are replaced whole when changed. */
export function buildInvoiceEdits(review: InvoiceIntakeReview, header: Row, lots: Row[], fees: Row[]): Partial<InvoiceValues> {
  const edits: Record<string, unknown> = {};
  for (const f of HEADER_FIELDS) {
    const value = fromForm(f.kind, header[f.name] ?? "");
    if (value !== review.extracted[f.name].value) edits[f.name] = value;
  }
  const lotValues = lots.map(lotFromRow);
  const feeValues = fees.map(feeFromRow);
  if (JSON.stringify(lotValues) !== JSON.stringify(plain(review.extracted.lots as any))) edits.lots = lotValues;
  if (JSON.stringify(feeValues) !== JSON.stringify(plain(review.extracted.fees as any))) edits.fees = feeValues;
  return edits as Partial<InvoiceValues>;
}

function Evidence({ field, edited }: { field?: ExtractedField<unknown>; edited: boolean }) {
  if (edited) return <p style={evidenceStyle}>Edited by you</p>;
  if (!field) return null;
  const low = field.value !== null && field.confidence < LOW_CONFIDENCE;
  return (
    <p style={evidenceStyle}>
      {field.evidence ? <>Evidence: “{field.evidence}”</> : field.value !== null ? <>No evidence in the document</> : <>Not found</>}
      {low && <strong style={{ color: "#d9a441" }}> · low confidence ({Math.round(field.confidence * 100)}%)</strong>}
    </p>
  );
}

const isLow = (field: ExtractedField<unknown> | undefined, edited: boolean) => !edited && !!field && field.value !== null && field.confidence < LOW_CONFIDENCE;

export function InvoiceReviewPanel({ intake, editable, onSaved }: { intake: InvoiceIntake & { review: InvoiceIntakeReview }; editable: boolean; onSaved: () => void }) {
  const review = intake.review;
  const [header, setHeader] = useState<Row>(() => toRow(Object.fromEntries(HEADER_FIELDS.map((f) => [f.name, review.effective[f.name]]))));
  const [lots, setLots] = useState<Row[]>(() => review.effective.lots.map(toRow));
  const [fees, setFees] = useState<Row[]>(() => review.effective.fees.map(toRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited = new Set(review.editedFields);
  const blocked = hasTotalMismatch(review.checks);

  async function submit(confirm: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoiceIntakeApi.reviewIntake(intake.id, buildInvoiceEdits(review, header, lots, fees), confirm);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the review");
    } finally {
      setBusy(false);
    }
  }

  const setCell = (setter: typeof setLots, index: number, key: string, value: string) =>
    setter((rows) => rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));

  function headerInput(f: (typeof HEADER_FIELDS)[number]) {
    const field = review.extracted[f.name] as ExtractedField<unknown>;
    const style = isLow(field, edited.has(f.name)) ? lowStyle : inputStyle;
    const common = { id: `${intake.id}-${f.name}`, style, disabled: !editable, value: header[f.name] ?? "" };
    const set = (v: string) => setHeader((h) => ({ ...h, [f.name]: v }));
    if (f.kind === "type") {
      return <select {...common} onChange={(e) => set(e.target.value)}><option value="">—</option>{INVOICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>;
    }
    if (f.kind === "boolean") {
      return <select {...common} onChange={(e) => set(e.target.value)}><option value="">unknown</option><option value="true">yes</option><option value="false">no</option></select>;
    }
    return <input {...common} type={f.kind === "date" ? "date" : f.kind === "number" ? "number" : "text"} step={f.kind === "number" ? "0.01" : undefined} onChange={(e) => set(e.target.value)} />;
  }

  const lotsEdited = edited.has("lots");
  const feesEdited = edited.has("fees");
  const cell = (rowsEdited: boolean, source: Array<Record<string, ExtractedField<unknown>>>, i: number, key: string) => {
    const field = rowsEdited ? undefined : source[i]?.[key];
    return { style: isLow(field, rowsEdited) ? lowStyle : inputStyle, title: field?.evidence ? `Evidence: ${field.evidence}` : undefined };
  };

  return (
    <section aria-label={`Review ${intake.originalFilenameSanitized ?? intake.id}`} style={{ border: "1px solid var(--noctella-antique-gold)", borderRadius: 6, padding: 12, marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Review: {intake.originalFilenameSanitized ?? intake.id} <small>({intake.status})</small></h3>

      <div role="list" aria-label="Checks" style={{ marginBottom: 12 }}>
        {review.checks.map((c, i) => (
          <p role="listitem" key={`${c.code}-${i}`} style={{ margin: "2px 0", color: c.ok ? "#6ac87a" : "#c86a6a" }}>
            {c.ok ? "✓" : "✗"} {c.message}{c.fields?.length ? `: ${c.fields.join(", ")}` : ""}
          </p>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
        {HEADER_FIELDS.map((f) => (
          <div key={f.name}>
            <label htmlFor={`${intake.id}-${f.name}`} style={{ display: "block", fontSize: 12 }}>{f.label}</label>
            {headerInput(f)}
            <Evidence field={review.extracted[f.name] as ExtractedField<unknown>} edited={edited.has(f.name)} />
          </div>
        ))}
      </div>

      <h4>Lots</h4>
      <table style={{ width: "100%", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left" }}><th>Lot number</th><th>Title</th><th>Items</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          {lots.map((r, i) => (
            <tr key={i}>
              {(["lotNumber", "title", "itemCountHint", "amount"] as const).map((key) => (
                <td key={key}>
                  <input aria-label={`Lot ${i + 1} ${key}`} disabled={!editable} type={key === "amount" || key === "itemCountHint" ? "number" : "text"} value={r[key]} onChange={(e) => setCell(setLots, i, key, e.target.value)} {...cell(lotsEdited, review.extracted.lots as any, i, key)} />
                </td>
              ))}
              <td>{editable && <button type="button" style={buttonStyle} onClick={() => setLots((rows) => rows.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && <button type="button" style={buttonStyle} onClick={() => setLots((rows) => [...rows, { lotNumber: "", title: "", itemCountHint: "", amount: "" }])}>Add lot</button>}

      <h4>Fees</h4>
      <table style={{ width: "100%", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left" }}><th>Type</th><th>Label</th><th>Amount</th><th>Percent</th><th>Lot</th><th></th></tr></thead>
        <tbody>
          {fees.map((r, i) => (
            <tr key={i}>
              <td>
                <select aria-label={`Fee ${i + 1} type`} disabled={!editable} value={r.type} onChange={(e) => setCell(setFees, i, "type", e.target.value)} {...cell(feesEdited, review.extracted.fees as any, i, "type")}>
                  <option value="">—</option>
                  {INVOICE_FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              {(["label", "amount", "percent", "lotNumber"] as const).map((key) => (
                <td key={key}>
                  <input aria-label={`Fee ${i + 1} ${key}`} disabled={!editable} type={key === "amount" || key === "percent" ? "number" : "text"} value={r[key]} onChange={(e) => setCell(setFees, i, key, e.target.value)} {...cell(feesEdited, review.extracted.fees as any, i, key)} />
                </td>
              ))}
              <td>{editable && <button type="button" style={buttonStyle} onClick={() => setFees((rows) => rows.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && <button type="button" style={buttonStyle} onClick={() => setFees((rows) => [...rows, { type: "other", label: "", amount: "", percent: "", lotNumber: "" }])}>Add fee</button>}

      {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      {editable && (
        <div style={{ marginTop: 12 }}>
          <button type="button" disabled={busy} style={buttonStyle} onClick={() => submit(false)}>{busy ? "Saving…" : "Save edits"}</button>
          <button type="button" disabled={busy || blocked} style={buttonStyle} onClick={() => submit(true)} title={blocked ? "Fix the total mismatch and save first" : undefined}>Confirm review</button>
          {blocked && <span style={{ fontSize: 12, color: "#c86a6a" }}>Confirm is disabled while the total does not match.</span>}
        </div>
      )}
    </section>
  );
}
