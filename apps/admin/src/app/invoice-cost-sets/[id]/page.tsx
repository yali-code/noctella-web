"use client";

import { useEffect, useRef, useState } from "react";
import { formatFileSize, INVOICE_TYPES, invoiceIntakeApi, type InvoiceCostSetDetail, type InvoiceIntake, type InvoiceIntakeReview, type InvoiceType } from "@/lib/invoiceIntakes";
import { InvoiceReviewPanel } from "@/components/InvoiceReviewPanel";

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

export default function InvoiceCostSetDetailPage({ params }: { params: { id: string } }) {
  const [costSet, setCostSet] = useState<InvoiceCostSetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [invoiceType, setInvoiceType] = useState<InvoiceType>("auction");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    invoiceIntakeApi
      .getCostSet(params.id)
      .then(setCostSet)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load cost set"))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [params.id]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function handleUpload() {
    return run(async () => {
      if (!file) throw new Error("Choose an invoice file first");
      await invoiceIntakeApi.uploadFile(params.id, invoiceType, file);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    }, "Failed to upload invoice");
  }

  async function handleExtract(id: string) {
    if (busy) return;
    setExtractingId(id);
    try {
      await run(() => invoiceIntakeApi.extractIntake(id), "The invoice could not be read by AI");
    } finally {
      setExtractingId(null);
    }
  }

  if (loading && !costSet) return <main><p style={{ color: "var(--noctella-aged-bronze)" }}>Loading cost set...</p></main>;
  if (loadError && !costSet) return <main><p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p></main>;
  if (!costSet) return null;

  const open = costSet.status === "open";
  const reviewable = costSet.intakes.filter((i): i is InvoiceIntake & { review: InvoiceIntakeReview } => !!i.review && (i.status === "extracted" || i.status === "reviewed"));

  return (
    <main>
      <p><a href="/invoice-cost-sets">← Cost sets</a></p>
      <h1>{costSet.title}</h1>
      <p>Status: <strong>{costSet.status}</strong></p>
      {costSet.notes && <p>{costSet.notes}</p>}

      {open && (
        <section style={{ marginTop: 12 }}>
          <h2>Upload invoice</h2>
          <label>
            Invoice type{" "}
            <select style={inputStyle} value={invoiceType} onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}>
              {INVOICE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Invoice file{" "}
            <input ref={fileInput} style={inputStyle} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button disabled={busy} style={buttonStyle} onClick={handleUpload}>{busy ? "Working…" : "Upload"}</button>
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>PDF (max 5 pages), JPEG or PNG; 5 MB max.</p>
        </section>
      )}

      {actionError && <p role="alert" style={{ color: "#c86a6a" }}>{actionError}</p>}

      <h2>Invoices</h2>
      {costSet.intakes.length === 0 && <p>No invoices uploaded yet.</p>}
      {costSet.intakes.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Type</th><th>File name</th><th>Size</th><th>Uploaded at</th><th>Status</th><th></th><th></th><th></th>
            </tr>
          </thead>
          <tbody>
            {costSet.intakes.map((i) => (
              <tr key={i.id}>
                <td>{i.invoiceType}</td>
                <td>{i.originalFilenameSanitized ?? "—"}</td>
                <td>{formatFileSize(i.fileSizeBytes)}</td>
                <td>{new Date(i.createdAt).toLocaleString()}</td>
                <td>{i.status}</td>
                <td><a href={invoiceIntakeApi.fileUrl(i.id)} target="_blank" rel="noopener noreferrer">View file</a></td>
                <td>
                  {open && (i.status === "uploaded" || i.status === "extracted") && (
                    <button disabled={busy} style={buttonStyle} onClick={() => handleExtract(i.id)}>
                      {extractingId === i.id ? "Reading…" : i.status === "uploaded" ? "Read with AI" : "Read again"}
                    </button>
                  )}
                </td>
                <td>
                  {open && i.status !== "cancelled" && (
                    <button disabled={busy} style={buttonStyle} onClick={() => run(() => invoiceIntakeApi.cancelIntake(i.id), "Failed to cancel invoice")}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reviewable.map((i) => (
        <InvoiceReviewPanel key={`${i.id}-${i.updatedAt}`} intake={i} editable={open} onSaved={load} />
      ))}

      {open && (
        <div style={{ marginTop: 16 }}>
          <button disabled={busy} style={buttonStyle} onClick={() => run(() => invoiceIntakeApi.cancelCostSet(costSet.id), "Failed to cancel cost set")}>Cancel set</button>
        </div>
      )}
    </main>
  );
}
