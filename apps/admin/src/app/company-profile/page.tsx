"use client";

import { useEffect, useState } from "react";
import { companyProfileApi, TAX_TREATMENT_OPTIONS } from "@/lib/companyProfile";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
  marginBottom: 6,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--noctella-aged-bronze)", marginTop: 8 };

const FIELDS: Array<{ key: string; label: string; required?: boolean; type?: string }> = [
  { key: "legalName", label: "Legal company name", required: true },
  { key: "tradeName", label: "Trade name (optional)" },
  { key: "registrationNumber", label: "UIC / EIK / registration number", required: true },
  { key: "vatNumber", label: "VAT number" },
  { key: "addressLine1", label: "Address line 1", required: true },
  { key: "addressLine2", label: "Address line 2" },
  { key: "city", label: "City", required: true },
  { key: "postalCode", label: "Postal code", required: true },
  { key: "country", label: "Country", required: true },
  { key: "email", label: "Business email", required: true },
  { key: "phone", label: "Business phone", required: true },
  { key: "website", label: "Website (optional)" },
  { key: "bankName", label: "Bank name (optional)" },
  { key: "iban", label: "IBAN (optional)" },
  { key: "bic", label: "BIC / SWIFT (optional)" },
];

export default function CompanyProfilePage() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState("14");
  const [defaultVatRate, setDefaultVatRate] = useState("20");
  const [defaultTaxTreatment, setDefaultTaxTreatment] = useState("StandardVAT");
  const [defaultPricesIncludeVat, setDefaultPricesIncludeVat] = useState(false);
  const [invoiceFooter, setInvoiceFooter] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  function load() {
    setLoading(true);
    setLoadError(null);
    companyProfileApi
      .get()
      .then((p) => {
        setProfile(p);
        if (p?.configured !== false) {
          const next: Record<string, string> = {};
          for (const f of FIELDS) next[f.key] = p?.[f.key] ?? "";
          setForm(next);
          setDefaultPaymentTermsDays(String(p?.defaultPaymentTermsDays ?? 14));
          setDefaultVatRate(String(p?.defaultVatRate ?? 20));
          setDefaultTaxTreatment(p?.defaultTaxTreatment ?? "StandardVAT");
          setDefaultPricesIncludeVat(!!p?.defaultPricesIncludeVat);
          setInvoiceFooter(p?.invoiceFooter ?? "");
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load company profile"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSave() {
    if (saveBusy) return;
    setSaveBusy(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const payload: Record<string, unknown> = { ...form, defaultPaymentTermsDays: Number(defaultPaymentTermsDays), defaultVatRate: Number(defaultVatRate), defaultTaxTreatment, defaultPricesIncludeVat, invoiceFooter: invoiceFooter || null };
      if (profile?.configured !== false) payload.expectedUpdatedAt = profile.updatedAt;
      const updated = await companyProfileApi.update(payload);
      setProfile(updated);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save company profile");
    } finally {
      setSaveBusy(false);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading company profile...</p>;

  return (
    <main>
      <h1>Company Profile</h1>
      <p>
        This is the seller identity copied onto every new invoice draft. Editing it here only affects future
        drafts and future &quot;Refresh seller snapshot&quot; actions — already-issued invoices keep the
        point-in-time snapshot they were created with.
      </p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {profile?.configured === false && <p role="alert" style={{ color: "#c86a6a" }}>No company profile is configured yet. Invoices can still be drafted, but cannot be issued until this is completed.</p>}

      <section>
        <h2>Seller identity</h2>
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label style={labelStyle}>{f.label}{f.required ? " *" : ""}</label>
            <input style={{ ...inputStyle, width: 320 }} value={form[f.key] ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))} />
          </div>
        ))}
      </section>

      <section>
        <h2>Invoice defaults</h2>
        <div>
          <label style={labelStyle}>Default payment terms (days)</label>
          <input style={inputStyle} type="number" min={0} value={defaultPaymentTermsDays} onChange={(e) => setDefaultPaymentTermsDays(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Default VAT rate (%)</label>
          <input style={inputStyle} type="number" min={0} max={100} step={0.01} value={defaultVatRate} onChange={(e) => setDefaultVatRate(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Default tax treatment</label>
          <select style={inputStyle} value={defaultTaxTreatment} onChange={(e) => setDefaultTaxTreatment(e.target.value)}>
            {TAX_TREATMENT_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>
            <input type="checkbox" checked={defaultPricesIncludeVat} onChange={(e) => setDefaultPricesIncludeVat(e.target.checked)} /> Prices include VAT by default
          </label>
        </div>
        <div>
          <label style={labelStyle}>Invoice footer (optional)</label>
          <textarea style={{ ...inputStyle, width: 320, height: 60 }} value={invoiceFooter} onChange={(e) => setInvoiceFooter(e.target.value)} />
        </div>
      </section>

      <button disabled={saveBusy} style={buttonStyle} onClick={handleSave}>{saveBusy ? "Saving…" : "Save Company Profile"}</button>
      {saveError && <p role="alert" style={{ color: "#c86a6a" }}>{saveError}</p>}
      {saveSuccess && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Company profile saved.</p>}
    </main>
  );
}
