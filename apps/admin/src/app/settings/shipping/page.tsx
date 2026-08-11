"use client";

import { useEffect, useState } from "react";
import {
  PRODUCT_SHIPPING_PROFILE_VALUES,
  SHIPPING_RULE_TYPE_VALUES,
  ShippingRuleType,
  type ShippingMethod,
} from "@noctella/shared";
import { api, ApiError } from "@/lib/api";

/**
 * Sprint 134 correction: Admin UI for the shipping-method management API introduced by Sprint 134
 * (routes/shippingMethods.ts, services/shippingMethods.ts). Mirrors the existing categories page's
 * list+form pattern (apps/admin/src/app/categories/page.tsx) - same api.get/post/put usage, same
 * Field/table/style conventions. The API remains the sole authority: this form only converts
 * between human EUR input and the API's authoritative integer EUR-cents contract, and never
 * invents client-side rule validation beyond basic required-field UX (the server still enforces
 * assertValidRuleConfig). No delete action exists here, matching the API's own no-hard-delete
 * design - activate/deactivate (isActive) is the only lifecycle control, which is what preserves
 * Sprint 134's bootstrap-safety invariant (a shipping_methods row, once created, can never make the
 * table return to zero rows through normal Admin operation).
 */

const RULE_TYPE_LABELS: Record<string, string> = {
  [ShippingRuleType.Free]: "Free",
  [ShippingRuleType.FlatRate]: "Flat Rate",
  [ShippingRuleType.FreeOverSubtotal]: "Free Over Subtotal",
};

interface FormState {
  id?: string;
  label: string;
  isActive: boolean;
  sortOrder: string;
  ruleType: string;
  flatAmountEur: string;
  freeThresholdEur: string;
  countryCodes: string;
  shippingProfiles: string[];
}

const emptyForm: FormState = {
  label: "",
  isActive: true,
  sortOrder: "0",
  ruleType: ShippingRuleType.Free,
  flatAmountEur: "",
  freeThresholdEur: "",
  countryCodes: "",
  shippingProfiles: [],
};

/** Deterministic EUR -> integer EUR-cents conversion, matching the API's own toEurCents formula (apps/api/src/use-cases/order/useCases.ts) - never a lossy/ambiguous float comparison. Returns undefined for a blank/invalid/negative value so the caller can decide whether that's an error or "not set". */
function toCentsOrUndefined(eur: string): number | undefined {
  const trimmed = eur.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round((n + Number.EPSILON) * 100);
}

function fromCents(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function parseCountryCodes(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter((v) => v.length > 0);
}

export default function ShippingMethodsPage() {
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const res = await api.get<{ items: ShippingMethod[] }>("/api/shipping-methods");
    setMethods(res.items);
  }

  useEffect(() => {
    refresh()
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function edit(method: ShippingMethod) {
    setError(null);
    setFieldErrors({});
    setForm({
      id: method.id,
      label: method.label,
      isActive: method.isActive,
      sortOrder: String(method.sortOrder),
      ruleType: method.ruleType,
      flatAmountEur: fromCents(method.flatAmountEurCents),
      freeThresholdEur: fromCents(method.freeThresholdEurCents),
      countryCodes: method.countryCodes ? method.countryCodes.join(", ") : "",
      shippingProfiles: method.shippingProfiles ?? [],
    });
  }

  function toggleProfile(profile: string) {
    setForm((prev) => ({
      ...prev,
      shippingProfiles: prev.shippingProfiles.includes(profile)
        ? prev.shippingProfiles.filter((p) => p !== profile)
        : [...prev.shippingProfiles, profile],
    }));
  }

  async function toggleActive(method: ShippingMethod) {
    setError(null);
    try {
      await api.put(`/api/shipping-methods/${method.id}`, { isActive: !method.isActive });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const requiresFlatAmount = form.ruleType === ShippingRuleType.FlatRate || form.ruleType === ShippingRuleType.FreeOverSubtotal;
    const requiresThreshold = form.ruleType === ShippingRuleType.FreeOverSubtotal;
    const errors: Record<string, string> = {};
    if (!form.label.trim()) errors.label = "Label is required";
    const flatAmountEurCents = toCentsOrUndefined(form.flatAmountEur);
    if (requiresFlatAmount && flatAmountEurCents === undefined) errors.flatAmountEur = "A non-negative flat amount is required for this rule type";
    const freeThresholdEurCents = toCentsOrUndefined(form.freeThresholdEur);
    if (requiresThreshold && freeThresholdEurCents === undefined) errors.freeThresholdEur = "A non-negative threshold is required for this rule type";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const isEdit = Boolean(form.id);
    const countryCodes = parseCountryCodes(form.countryCodes);
    const shippingProfiles = form.shippingProfiles;
    const payload: Record<string, unknown> = {
      label: form.label.trim(),
      isActive: form.isActive,
      sortOrder: Number(form.sortOrder) || 0,
      ruleType: form.ruleType,
      // The create schema rejects explicit null (only undefined/omitted or a valid value); the
      // update schema is nullable so an edit can explicitly clear a previously-set amount/scope.
      flatAmountEurCents: requiresFlatAmount ? flatAmountEurCents : isEdit ? null : undefined,
      freeThresholdEurCents: requiresThreshold ? freeThresholdEurCents : isEdit ? null : undefined,
      countryCodes: countryCodes.length > 0 ? countryCodes : isEdit ? null : undefined,
      shippingProfiles: shippingProfiles.length > 0 ? shippingProfiles : isEdit ? null : undefined,
    };

    setSaving(true);
    try {
      if (isEdit) {
        await api.put(`/api/shipping-methods/${form.id}`, payload);
      } else {
        await api.post("/api/shipping-methods", payload);
      }
      setForm(emptyForm);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) {
          const mapped: Record<string, string> = {};
          for (const d of err.details) mapped[d.path] = d.message;
          setFieldErrors(mapped);
        }
      } else {
        setError("Something went wrong.");
      }
    } finally {
      setSaving(false);
    }
  }

  const requiresFlatAmount = form.ruleType === ShippingRuleType.FlatRate || form.ruleType === ShippingRuleType.FreeOverSubtotal;
  const requiresThreshold = form.ruleType === ShippingRuleType.FreeOverSubtotal;

  return (
    <div>
      <h1>Shipping Methods</h1>
      <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13, marginTop: 4 }}>
        Checkout shipping-price configuration (Free / Flat Rate / Free Over Subtotal). Not to be confused with the Shipping page, which tracks carrier fulfillment.
      </p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a", fontSize: 13 }}>{error}</p>}

      <div style={{ display: "flex", gap: 32 }}>
        <div className="noctella-panel" style={{ flex: 1, overflowX: "auto" }}>
          {loading ? (
            <p style={{ padding: 12, fontSize: 13 }}>Loading...</p>
          ) : methods.length === 0 ? (
            <p style={{ padding: 12, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>No shipping methods configured yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                  <th style={thStyle}>Label</th>
                  <th style={thStyle}>Active</th>
                  <th style={thStyle}>Order</th>
                  <th style={thStyle}>Rule</th>
                  <th style={thStyle}>Amount</th>
                  <th style={thStyle}>Threshold</th>
                  <th style={thStyle}>Countries</th>
                  <th style={thStyle}>Profiles</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {methods.map((m) => (
                  <tr key={m.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                    <td style={tdStyle}>{m.label}</td>
                    <td style={tdStyle}>{m.isActive ? "Yes" : "No"}</td>
                    <td style={tdStyle}>{m.sortOrder}</td>
                    <td style={tdStyle}>{RULE_TYPE_LABELS[m.ruleType] ?? m.ruleType}</td>
                    <td style={tdStyle}>{m.flatAmountEurCents == null ? "—" : `€${fromCents(m.flatAmountEurCents)}`}</td>
                    <td style={tdStyle}>{m.freeThresholdEurCents == null ? "—" : `€${fromCents(m.freeThresholdEurCents)}`}</td>
                    <td style={tdStyle}>{m.countryCodes && m.countryCodes.length > 0 ? m.countryCodes.join(", ") : "All"}</td>
                    <td style={tdStyle}>{m.shippingProfiles && m.shippingProfiles.length > 0 ? m.shippingProfiles.join(", ") : "All"}</td>
                    <td style={tdStyle}>
                      <button style={linkButtonStyle} onClick={() => edit(m)}>
                        Edit
                      </button>
                      <button style={linkButtonStyle} onClick={() => toggleActive(m)}>
                        {m.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form
          onSubmit={handleSubmit}
          className="noctella-panel"
          style={{ width: 360, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h3 style={{ margin: 0 }}>{form.id ? "Edit Shipping Method" : "New Shipping Method"}</h3>

          <Field label="Label" error={fieldErrors.label}>
            <input style={inputStyle} value={form.label} onChange={(e) => set("label", e.target.value)} />
          </Field>

          <Field label="Rule Type">
            <select style={inputStyle} value={form.ruleType} onChange={(e) => set("ruleType", e.target.value)}>
              {SHIPPING_RULE_TYPE_VALUES.map((rt) => (
                <option key={rt} value={rt}>
                  {RULE_TYPE_LABELS[rt] ?? rt}
                </option>
              ))}
            </select>
          </Field>

          {requiresFlatAmount && (
            <Field label={form.ruleType === ShippingRuleType.FreeOverSubtotal ? "Flat Amount Below Threshold (EUR)" : "Flat Amount (EUR)"} error={fieldErrors.flatAmountEur}>
              <input
                type="number"
                min="0"
                step="0.01"
                style={inputStyle}
                value={form.flatAmountEur}
                onChange={(e) => set("flatAmountEur", e.target.value)}
              />
            </Field>
          )}

          {requiresThreshold && (
            <Field label="Free-Shipping Threshold (EUR subtotal)" error={fieldErrors.freeThresholdEur}>
              <input
                type="number"
                min="0"
                step="0.01"
                style={inputStyle}
                value={form.freeThresholdEur}
                onChange={(e) => set("freeThresholdEur", e.target.value)}
              />
            </Field>
          )}

          <Field label="Sort Order">
            <input style={inputStyle} value={form.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} />
          </Field>

          <Field label="Country Eligibility (comma-separated 2-letter codes, blank = all countries)">
            <input
              style={inputStyle}
              placeholder="e.g. BG, DE, FR"
              value={form.countryCodes}
              onChange={(e) => set("countryCodes", e.target.value)}
            />
          </Field>

          <Field label="Product Shipping-Profile Eligibility (none selected = all profiles)">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {PRODUCT_SHIPPING_PROFILE_VALUES.map((profile) => (
                <label key={profile} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={form.shippingProfiles.includes(profile)}
                    onChange={() => toggleProfile(profile)}
                  />
                  {profile}
                </label>
              ))}
            </div>
          </Field>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
            Active
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "10px 18px",
                background: "var(--noctella-antique-gold)",
                color: "var(--noctella-night-navy)",
                border: "none",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {saving ? "Saving..." : form.id ? "Save Changes" : "Create Shipping Method"}
            </button>
            {form.id && (
              <button type="button" style={linkButtonStyle} onClick={() => setForm(emptyForm)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      {children}
      {error && <span style={{ color: "#c86a6a", fontSize: 12 }}>{error}</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--noctella-bright-star-gold)",
  cursor: "pointer",
  fontSize: 13,
  marginRight: 12,
  padding: 0,
};
