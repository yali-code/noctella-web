"use client";

import { useEffect, useState } from "react";
import {
  euro,
  invoicesApi,
  recalculateInvoiceDraft,
  refreshInvoiceSellerSnapshot,
  switchInvoiceCalculationMode,
  updateInvoiceDraft,
  updateInvoiceLine,
} from "@/lib/erpSalesFinanceBridge";
import { TAX_TREATMENT_OPTIONS } from "@/lib/companyProfile";
import { cancelInvoice, issueInvoice, markInvoicePaid } from "@/lib/erpSalesFinanceBridge";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
  marginBottom: 4,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--noctella-aged-bronze)" };

function parseSnapshot(raw: unknown) {
  if (raw == null) return {};
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

export default function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const [invoice, setInvoice] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [readiness, setReadiness] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    invoicesApi
      .invoice(params.id)
      .then((inv) => {
        setInvoice(inv);
        invoicesApi.events(params.id).then((r) => setEvents(r.items ?? [])).catch(() => setEvents([]));
        if (inv.status === "Draft") invoicesApi.issueReadiness(params.id).then(setReadiness).catch(() => setReadiness(null));
        else setReadiness(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load invoice"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  const [lineEdits, setLineEdits] = useState<Record<string, Record<string, string>>>({});
  function lineValue(lineId: string, field: string, fallback: unknown) {
    return lineEdits[lineId]?.[field] ?? String(fallback ?? "");
  }
  function setLineField(lineId: string, field: string, value: string) {
    setLineEdits((prev) => ({ ...prev, [lineId]: { ...prev[lineId], [field]: value } }));
  }
  async function saveLine(lineId: string) {
    const edits = lineEdits[lineId];
    if (!edits) return;
    setBusyCount((c) => c + 1);
    setActionError(null);
    try {
      const payload: any = {};
      if (edits.titleSnapshot !== undefined) payload.titleSnapshot = edits.titleSnapshot;
      if (edits.quantity !== undefined) payload.quantity = Number(edits.quantity);
      if (edits.unitPrice !== undefined) payload.unitPrice = Number(edits.unitPrice);
      if (edits.discountAmount !== undefined) payload.discountAmount = Number(edits.discountAmount);
      if (edits.vatRate !== undefined) payload.vatRate = Number(edits.vatRate);
      if (edits.manualVatAmount !== undefined && edits.manualVatAmount !== "") payload.manualVatAmount = Number(edits.manualVatAmount);
      const updated = await updateInvoiceLine(invoice.id, lineId, payload);
      setInvoice(updated);
      setLineEdits((prev) => { const next = { ...prev }; delete next[lineId]; return next; });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update line");
    } finally {
      setBusyCount((c) => c - 1);
    }
  }

  const [invoiceForm, setInvoiceForm] = useState<Record<string, string>>({});
  function invoiceFieldValue(field: string, fallback: unknown) {
    return invoiceForm[field] ?? String(fallback ?? "");
  }
  async function saveInvoiceFields() {
    if (!Object.keys(invoiceForm).length) return;
    setBusyCount((c) => c + 1);
    setActionError(null);
    try {
      const payload: any = {};
      if (invoiceForm.shippingAmount !== undefined) payload.shippingAmount = Number(invoiceForm.shippingAmount);
      if (invoiceForm.shippingVatRate !== undefined) payload.shippingVatRate = Number(invoiceForm.shippingVatRate);
      if (invoiceForm.discountAmount !== undefined) payload.discountAmount = Number(invoiceForm.discountAmount);
      if (invoiceForm.dueAt !== undefined) payload.dueAt = invoiceForm.dueAt || null;
      if (invoiceForm.notes !== undefined) payload.notes = invoiceForm.notes;
      if (invoiceForm.invoiceFooter !== undefined) payload.invoiceFooter = invoiceForm.invoiceFooter;
      if (invoiceForm.taxTreatment !== undefined) payload.taxTreatment = invoiceForm.taxTreatment;
      payload.pricesIncludeVat = pricesIncludeVat;
      const updated = await updateInvoiceDraft(invoice.id, payload);
      setInvoice(updated);
      setInvoiceForm({});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update invoice");
    } finally {
      setBusyCount((c) => c - 1);
    }
  }
  const [pricesIncludeVat, setPricesIncludeVat] = useState(false);
  // Deliberately keyed on invoice?.id only, not the whole invoice object: this resets the
  // checkbox when a *different* invoice loads, but must not fight the admin's in-progress edit
  // every time `invoice` itself changes (e.g. right after a save reloads the same invoice).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (invoice) setPricesIncludeVat(!!invoice.pricesIncludeVat); }, [invoice?.id]);

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading invoice...</p>;
  if (loadError && !invoice) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!invoice) return null;

  const isDraft = invoice.status === "Draft";
  const isIssued = invoice.status === "Issued";
  const blockedByOther = busyCount > 0;
  const seller = parseSnapshot(invoice.sellerSnapshot);
  const customer = parseSnapshot(invoice.customerSnapshot);
  const billing = parseSnapshot(invoice.billingAddressSnapshot);

  return (
    <main>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-invoice { box-shadow: none !important; border: none !important; }
        }
      `}</style>

      <div className="no-print">
        <h1>Invoice {invoice.invoiceNumber ?? "(Draft)"}</h1>
        <p>Order <a href={`/orders/${invoice.orderId}`}>{invoice.orderId}</a> · Type {invoice.invoiceType} · Status {invoice.status} · Calculation mode {invoice.calculationMode}</p>
        {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
        {actionError && <p role="alert" style={{ color: "#c86a6a" }}>{actionError}</p>}

        {isDraft && readiness && !readiness.ready && (
          <div role="alert" style={{ color: "#c86a6a" }}>
            <p>Not ready to issue:</p>
            <ul>{readiness.issues.map((issue: string) => <li key={issue}>{issue}</li>)}</ul>
          </div>
        )}

        <section>
          <h2>Draft actions</h2>
          {isDraft && (
            <>
              <button style={buttonStyle} disabled={blockedByOther} onClick={async () => { setBusyCount((c) => c + 1); setActionError(null); try { setInvoice(await switchInvoiceCalculationMode(invoice.id, invoice.calculationMode === "Automatic" ? "ManualOverride" : "Automatic")); } catch (err) { setActionError(err instanceof Error ? err.message : "Failed to switch mode"); } finally { setBusyCount((c) => c - 1); } }}>
                Switch to {invoice.calculationMode === "Automatic" ? "Manual Override" : "Automatic"}
              </button>
              <button style={buttonStyle} disabled={blockedByOther} onClick={async () => { setBusyCount((c) => c + 1); setActionError(null); try { setInvoice(await recalculateInvoiceDraft(invoice.id)); } catch (err) { setActionError(err instanceof Error ? err.message : "Failed to recalculate"); } finally { setBusyCount((c) => c - 1); } }}>
                Recalculate
              </button>
              <button style={buttonStyle} disabled={blockedByOther} onClick={async () => { setBusyCount((c) => c + 1); setActionError(null); try { setInvoice(await refreshInvoiceSellerSnapshot(invoice.id)); } catch (err) { setActionError(err instanceof Error ? err.message : "Failed to refresh seller snapshot"); } finally { setBusyCount((c) => c - 1); } }}>
                Refresh Seller Snapshot
              </button>
              <ConfirmButton
                label="Issue Invoice"
                eligible={isDraft}
                blockedByOther={blockedByOther}
                onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
                onSuccess={load}
                run={() => issueInvoice(invoice.id).then(() => {})}
              />
              <ConfirmButton
                label="Cancel Draft"
                eligible={isDraft}
                blockedByOther={blockedByOther}
                onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
                onSuccess={load}
                run={() => cancelInvoice(invoice.id).then(() => {})}
              />
            </>
          )}
          <button style={buttonStyle} onClick={() => window.print()}>Print Invoice</button>
          {isIssued && (
            <>
              <ConfirmButton
                label="Mark Paid"
                eligible={isIssued}
                blockedByOther={blockedByOther}
                onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
                onSuccess={load}
                run={() => markInvoicePaid(invoice.id).then(() => {})}
              />
              <ConfirmButton
                label="Cancel Invoice"
                eligible={isIssued}
                blockedByOther={blockedByOther}
                onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
                onSuccess={load}
                run={() => cancelInvoice(invoice.id).then(() => {})}
              />
            </>
          )}
        </section>

        {isDraft && (
          <section>
            <h2>Edit Draft</h2>
            <label style={labelStyle}>Tax treatment</label>
            <select style={inputStyle} value={invoiceFieldValue("taxTreatment", invoice.taxTreatment)} onChange={(e) => setInvoiceForm((p) => ({ ...p, taxTreatment: e.target.value }))}>
              {TAX_TREATMENT_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label style={labelStyle}>
              <input type="checkbox" checked={pricesIncludeVat} onChange={(e) => setPricesIncludeVat(e.target.checked)} /> Prices include VAT
            </label>
            <label style={labelStyle}>Shipping amount</label>
            <input style={inputStyle} type="number" step={0.01} value={invoiceFieldValue("shippingAmount", invoice.shippingAmount)} onChange={(e) => setInvoiceForm((p) => ({ ...p, shippingAmount: e.target.value }))} />
            <label style={labelStyle}>Shipping VAT rate (%)</label>
            <input style={inputStyle} type="number" step={0.01} min={0} max={100} value={invoiceFieldValue("shippingVatRate", invoice.shippingVatRate)} onChange={(e) => setInvoiceForm((p) => ({ ...p, shippingVatRate: e.target.value }))} />
            <label style={labelStyle}>Invoice-level discount</label>
            <input style={inputStyle} type="number" step={0.01} min={0} value={invoiceFieldValue("discountAmount", invoice.discountAmount)} onChange={(e) => setInvoiceForm((p) => ({ ...p, discountAmount: e.target.value }))} />
            <label style={labelStyle}>Due date</label>
            <input style={inputStyle} type="text" placeholder="ISO date" value={invoiceFieldValue("dueAt", invoice.dueAt)} onChange={(e) => setInvoiceForm((p) => ({ ...p, dueAt: e.target.value }))} />
            <label style={labelStyle}>Notes</label>
            <input style={{ ...inputStyle, width: 300 }} value={invoiceFieldValue("notes", invoice.notes)} onChange={(e) => setInvoiceForm((p) => ({ ...p, notes: e.target.value }))} />
            <label style={labelStyle}>Invoice footer override</label>
            <input style={{ ...inputStyle, width: 300 }} value={invoiceFieldValue("invoiceFooter", invoice.invoiceFooter)} onChange={(e) => setInvoiceForm((p) => ({ ...p, invoiceFooter: e.target.value }))} />
            <div>
              <button style={buttonStyle} disabled={blockedByOther} onClick={saveInvoiceFields}>Save Invoice Fields</button>
            </div>
          </section>
        )}

        <section>
          <h2>Event history</h2>
          <ul>
            {events.map((e) => (
              <li key={e.id}>{e.createdAt} — {e.eventType} ({e.previousStatus ?? "—"} → {e.newStatus ?? "—"})</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="print-invoice" style={{ border: "1px solid var(--noctella-antique-gold)", padding: 16, marginTop: 16 }}>
        <h2>{seller?.legalName ?? "(Company profile not configured)"}</h2>
        {seller?.configured !== false && (
          <p>
            {[seller.addressLine1, seller.addressLine2, seller.city, seller.postalCode, seller.country].filter(Boolean).join(", ")}
            <br />
            {seller.registrationNumber && `Reg. no.: ${seller.registrationNumber}`} {seller.vatNumber && `· VAT: ${seller.vatNumber}`}
            <br />
            {seller.email} {seller.phone && `· ${seller.phone}`}
          </p>
        )}

        <h3>Invoice {invoice.invoiceNumber ?? "(Draft — not yet issued)"}</h3>
        <p>Issue date: {invoice.issuedAt ?? "—"} · Due date: {invoice.dueAt ?? "—"} · Order: {invoice.orderId}</p>
        <p>Tax treatment: {invoice.taxTreatment}</p>

        <h3>Bill to</h3>
        <p>
          {customer?.name ?? billing?.fullName ?? "—"}
          <br />
          {[billing?.line1, billing?.line2, billing?.city, billing?.postalCode, billing?.country].filter(Boolean).join(", ")}
        </p>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Description</th><th>Qty</th><th>Unit price</th><th>Discount</th><th>VAT rate</th><th>VAT amount</th><th>Line total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line: any) => (
              <tr key={line.id}>
                <td>
                  {isDraft ? (
                    <input style={inputStyle} value={lineValue(line.id, "titleSnapshot", line.titleSnapshot)} onChange={(e) => setLineField(line.id, "titleSnapshot", e.target.value)} />
                  ) : line.titleSnapshot}
                </td>
                <td>
                  {isDraft ? (
                    <input style={{ ...inputStyle, width: 60 }} type="number" min={1} value={lineValue(line.id, "quantity", line.quantity)} onChange={(e) => setLineField(line.id, "quantity", e.target.value)} />
                  ) : line.quantity}
                </td>
                <td>
                  {isDraft ? (
                    <input style={{ ...inputStyle, width: 80 }} type="number" step={0.01} value={lineValue(line.id, "unitPrice", line.unitPrice)} onChange={(e) => setLineField(line.id, "unitPrice", e.target.value)} />
                  ) : euro(line.unitPrice)}
                </td>
                <td>
                  {isDraft ? (
                    <input style={{ ...inputStyle, width: 80 }} type="number" step={0.01} min={0} value={lineValue(line.id, "discountAmount", line.discountAmount)} onChange={(e) => setLineField(line.id, "discountAmount", e.target.value)} />
                  ) : euro(line.discountAmount)}
                </td>
                <td>
                  {isDraft ? (
                    <input style={{ ...inputStyle, width: 60 }} type="number" step={0.01} min={0} max={100} value={lineValue(line.id, "vatRate", line.vatRate)} onChange={(e) => setLineField(line.id, "vatRate", e.target.value)} />
                  ) : `${line.vatRate}%`}
                </td>
                <td>
                  {isDraft && invoice.calculationMode === "ManualOverride" ? (
                    <input style={{ ...inputStyle, width: 80 }} type="number" step={0.01} placeholder={euro(line.taxVatAmount)} value={lineValue(line.id, "manualVatAmount", "")} onChange={(e) => setLineField(line.id, "manualVatAmount", e.target.value)} />
                  ) : euro(line.taxVatAmount)}
                </td>
                <td>{euro(line.lineTotal)}</td>
                {isDraft && (
                  <td className="no-print">
                    <button style={buttonStyle} disabled={blockedByOther || !lineEdits[line.id]} onClick={() => saveLine(line.id)}>Save</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ textAlign: "right" }}>
          Subtotal: {euro(invoice.subtotal)}<br />
          Discount: -{euro(invoice.discountAmount)}<br />
          Shipping: {euro(invoice.shippingAmount)} (+{euro(invoice.shippingVatAmount)} VAT)<br />
          Total VAT: {euro(invoice.taxVatAmount)}<br />
          <strong>Total: {euro(invoice.totalAmount)} EUR</strong>
        </p>

        {(invoice.notes || invoice.invoiceFooter || seller?.invoiceFooter) && (
          <p style={{ fontSize: 12 }}>{invoice.invoiceFooter ?? seller?.invoiceFooter}{invoice.notes ? ` — ${invoice.notes}` : ""}</p>
        )}
      </section>
    </main>
  );
}
