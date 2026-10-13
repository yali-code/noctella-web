"use client";

import { useState } from "react";
import { ETSY_ID_PATTERN, ETSY_LISTING_LIMITS, EtsyRenewalOption, EtsyWhoMade, parseEtsyWhenMade, type Product } from "@noctella/shared";

/**
 * Etsy listing form parity (Phase 1): the Etsy New Listing form's structured fields. Draft saves are
 * never blocked here - messages mirror the API's publish gate so the seller sees what Etsy will need.
 * Nothing on this form is sent to Etsy yet, and promotional options default to off.
 */
export interface EtsyListingFormValues {
  etsyTaxonomyId?: string;
  etsyShopSectionId?: string;
  etsyQuantity?: string;
  etsySku?: string;
  etsyWhoMade?: string;
  /** "" = not set, "finished" = a finished product, "supply" = a supply or tool. */
  etsyWhatIsIt?: string;
  etsyWhenMade?: string;
  etsyVintageYear?: string;
  etsyShippingProfileId?: string;
  etsyProcessingProfileId?: string;
  etsyReturnPolicyId?: string;
  etsyRenewalOption?: string;
  etsyFeatured?: boolean;
  etsyAdsOptIn?: boolean;
  etsyRestockRequests?: boolean;
  etsyGpsrManufacturerName?: string;
  etsyGpsrManufacturerAddress?: string;
  etsyGpsrManufacturerContact?: string;
  etsyGpsrResponsiblePersonName?: string;
  etsyGpsrResponsiblePersonAddress?: string;
  etsyGpsrResponsiblePersonContact?: string;
  etsyGpsrSafetyInformation?: string;
  etsyConsumerGuaranteeInfo?: string;
}

const TEXT_KEYS = [
  "etsyTaxonomyId", "etsyShopSectionId", "etsySku", "etsyWhoMade", "etsyWhenMade", "etsyShippingProfileId", "etsyProcessingProfileId",
  "etsyReturnPolicyId", "etsyRenewalOption", "etsyGpsrManufacturerName", "etsyGpsrManufacturerAddress", "etsyGpsrManufacturerContact",
  "etsyGpsrResponsiblePersonName", "etsyGpsrResponsiblePersonAddress", "etsyGpsrResponsiblePersonContact", "etsyGpsrSafetyInformation",
  "etsyConsumerGuaranteeInfo",
] as const;

export function etsyFormValuesFromProduct(product: Partial<Product>): EtsyListingFormValues {
  const out: EtsyListingFormValues = {};
  for (const key of TEXT_KEYS) out[key] = product[key] ?? undefined;
  out.etsyQuantity = product.etsyQuantity?.toString();
  out.etsyVintageYear = product.etsyVintageYear?.toString();
  out.etsyWhatIsIt = product.etsyIsSupply === undefined ? "" : product.etsyIsSupply ? "supply" : "finished";
  out.etsyFeatured = product.etsyFeatured;
  out.etsyAdsOptIn = product.etsyAdsOptIn;
  out.etsyRestockRequests = product.etsyRestockRequests;
  return out;
}

const textOrNull = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
const intOrNull = (value: string | undefined) => (value && value.trim() ? Number(value) : null);

/** Empty inputs are sent as null so a previously saved Etsy value can be cleared. */
export function etsyPayloadFromValues(values: EtsyListingFormValues) {
  const out: Record<string, unknown> = {};
  for (const key of TEXT_KEYS) out[key] = textOrNull(values[key]);
  out.etsyQuantity = intOrNull(values.etsyQuantity);
  out.etsyVintageYear = intOrNull(values.etsyVintageYear);
  out.etsyIsSupply = values.etsyWhatIsIt === "supply" ? true : values.etsyWhatIsIt === "finished" ? false : null;
  out.etsyFeatured = values.etsyFeatured ?? null;
  out.etsyAdsOptIn = values.etsyAdsOptIn ?? null;
  out.etsyRestockRequests = values.etsyRestockRequests ?? null;
  return out;
}

/** Non-blocking limit hints for the existing Etsy title, tags and materials inputs. */
export function etsyLimitMessage(field: "etsyTitle" | "etsyTags" | "etsyMaterials", value: string | undefined): string | undefined {
  const L = ETSY_LISTING_LIMITS;
  if (!value) return undefined;
  if (field === "etsyTitle") return value.length > L.titleMaxLength ? `Etsy allows at most ${L.titleMaxLength} characters (${value.length} now) - required before publishing` : undefined;
  const items = value.split(",").map((v) => v.trim()).filter(Boolean);
  const [max, each, label] = field === "etsyTags" ? [L.tagsMax, L.tagMaxLength, "tags"] : [L.materialsMax, L.materialMaxLength, "materials"];
  // Tag limits are enforced by Etsy; the material limits are not yet verified against the API (warning only).
  const consequence = field === "etsyTags" ? "required before publishing" : "limit to be verified against the Etsy API";
  if (items.length > max) return `Etsy allows at most ${max} ${label} (${items.length} now) - ${consequence}`;
  if (items.some((item) => item.length > each)) return `Each Etsy ${label === "tags" ? "tag" : "material"} must be at most ${each} characters`;
  return undefined;
}

/** Field-level messages; structural problems will also be rejected by the API on save. */
export function etsyFieldMessages(values: EtsyListingFormValues): Partial<Record<keyof EtsyListingFormValues, string>> {
  const m: Partial<Record<keyof EtsyListingFormValues, string>> = {};
  for (const key of ["etsyTaxonomyId", "etsyShopSectionId", "etsyShippingProfileId", "etsyProcessingProfileId", "etsyReturnPolicyId"] as const) {
    const v = values[key]?.trim();
    if (v && !ETSY_ID_PATTERN.test(v)) m[key] = "Must be the numeric Etsy ID (digits only)";
  }
  const quantity = values.etsyQuantity?.trim();
  if (quantity && !(/^\d+$/.test(quantity) && Number(quantity) >= 1 && Number(quantity) <= 999)) m.etsyQuantity = "Whole number from 1 to 999";
  if (values.etsySku && values.etsySku.trim().length > ETSY_LISTING_LIMITS.skuMaxLength) m.etsySku = `Etsy allows at most ${ETSY_LISTING_LIMITS.skuMaxLength} characters - limit to be verified against the Etsy API`;
  const whenMade = values.etsyWhenMade?.trim();
  const span = whenMade ? parseEtsyWhenMade(whenMade) : null;
  if (whenMade && !span) m.etsyWhenMade = "Use made_to_order, a decade (1970s), a year range (2020_2026) or before_YYYY";
  const year = values.etsyVintageYear?.trim();
  if (year) {
    const y = Number(year);
    if (!/^\d{4}$/.test(year) || y > new Date().getFullYear()) m.etsyVintageYear = "Four-digit year, not in the future";
    else if (span && (span.kind === "made_to_order" || (span.fromYear !== null && y < span.fromYear) || (span.toYear !== null && y > span.toYear))) m.etsyVintageYear = "Must fall within 'When was it made'";
  }
  if (values.etsyWhoMade === EtsyWhoMade.SomeoneElse && values.etsyWhatIsIt === "finished" && span) {
    const latest = new Date().getFullYear() - ETSY_LISTING_LIMITS.vintageMinAgeYears;
    if (span.toYear === null || span.toYear > latest) m.etsyWhenMade = `Etsy policy: items made by someone else must be vintage (made in or before ${latest}) unless they are supplies`;
  }
  for (const key of ["etsyGpsrManufacturerContact", "etsyGpsrResponsiblePersonContact"] as const) {
    const v = values[key]?.trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/^https:\/\/[^\s]+$/i.test(v)) m[key] = "Email address or https:// URL";
  }
  return m;
}

const DECADES = ["2000s", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"];

export function EtsyListingFormFields<T extends EtsyListingFormValues>({ values, set: setValue, Field, inputStyle }: {
  values: T;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  Field: (props: { label: string; error?: string; children: React.ReactNode }) => React.ReactElement;
  inputStyle: React.CSSProperties;
}) {
  const set = <K extends keyof EtsyListingFormValues>(key: K, value: EtsyListingFormValues[K]) => setValue(key, value as T[K]);
  const msg = etsyFieldMessages(values);
  const text = (key: keyof EtsyListingFormValues, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Field label={label} error={msg[key]}>
      <input style={inputStyle} aria-label={label} value={(values[key] as string | undefined) ?? ""} onChange={(e) => set(key, e.target.value as never)} {...props} />
    </Field>
  );
  const area = (key: keyof EtsyListingFormValues, label: string) => (
    <Field label={label} error={msg[key]}>
      <textarea style={{ ...inputStyle, minHeight: 60 }} aria-label={label} value={(values[key] as string | undefined) ?? ""} onChange={(e) => set(key, e.target.value as never)} />
    </Field>
  );
  const check = (key: "etsyFeatured" | "etsyAdsOptIn" | "etsyRestockRequests", label: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <input type="checkbox" aria-label={label} checked={values[key] === true} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  );
  const sub = (title: string, note: string) => (
    <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--noctella-bright-star-gold)" }}>{title} <span style={{ color: "var(--noctella-aged-bronze)" }}>— {note}</span></p>
  );
  const listed = (v: string | undefined) => !v || DECADES.includes(v) || v === "made_to_order";
  // "Other" reveals a free-text Etsy period (e.g. 2020_2026); a stored non-listed value opens it.
  const [otherPeriod, setOtherPeriod] = useState(!listed(values.etsyWhenMade));

  return (
    <div data-testid="etsy-listing-form-fields" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {sub("Listing identity", "category ID required to publish; section, quantity and SKU optional")}
      {text("etsyTaxonomyId", "Etsy category (taxonomy ID) *", { inputMode: "numeric" })}
      {text("etsyShopSectionId", "Shop section ID", { inputMode: "numeric" })}
      {text("etsyQuantity", "Etsy quantity (blank = ERP stock; never above ERP stock)", { inputMode: "numeric" })}
      {text("etsySku", "Etsy SKU (blank = ERP SKU)")}

      {sub("About this item", "who made / when made required to publish; some categories need more attributes (Phase 3)")}
      <Field label="Who made it? *" error={msg.etsyWhoMade}>
        <select style={inputStyle} aria-label="Who made it?" value={values.etsyWhoMade ?? ""} onChange={(e) => set("etsyWhoMade", e.target.value)}>
          <option value="">— not set —</option>
          <option value={EtsyWhoMade.IDid}>I did</option>
          <option value={EtsyWhoMade.Collective}>A member of my shop</option>
          <option value={EtsyWhoMade.SomeoneElse}>Another company or person</option>
        </select>
      </Field>
      <Field label="What is it? (Etsy form; API requirement to be verified)">
        <select style={inputStyle} aria-label="What is it?" value={values.etsyWhatIsIt ?? ""} onChange={(e) => set("etsyWhatIsIt", e.target.value)}>
          <option value="">— not set —</option>
          <option value="finished">A finished product</option>
          <option value="supply">A supply or tool to make things</option>
        </select>
      </Field>
      <Field label="When was it made? *" error={otherPeriod ? undefined : msg.etsyWhenMade}>
        <select style={inputStyle} aria-label="When was it made?" value={otherPeriod ? "other" : values.etsyWhenMade ?? ""} onChange={(e) => { const v = e.target.value; setOtherPeriod(v === "other"); set("etsyWhenMade", v === "other" ? (listed(values.etsyWhenMade) ? "" : values.etsyWhenMade) : v); }}>
          <option value="">— not set —</option>
          <option value="made_to_order">Made to order</option>
          {DECADES.map((d) => <option key={d} value={d}>{d === "before_1700" ? "Before 1700" : d}</option>)}
          <option value="other">Other Etsy period (e.g. 2020_2026, before_2007)…</option>
        </select>
      </Field>
      {otherPeriod ? text("etsyWhenMade", "Exact Etsy period value") : null}
      {text("etsyVintageYear", "Vintage year (optional, must fall in the period)", { inputMode: "numeric" })}

      {sub("Shipping & returns", "Etsy shipping profile required to publish; separate from the ERP shipping profile")}
      {text("etsyShippingProfileId", "Etsy shipping profile ID *", { inputMode: "numeric" })}
      {text("etsyProcessingProfileId", "Etsy processing profile ID (Etsy form; API requirement to be verified)", { inputMode: "numeric" })}
      {text("etsyReturnPolicyId", "Etsy return policy ID (Etsy form; API requirement to be verified)", { inputMode: "numeric" })}

      {sub("Listing settings", "preferences only - not sent to Etsy in Phase 1; promotions stay off")}
      <Field label="Renewal">
        <select style={inputStyle} aria-label="Renewal" value={values.etsyRenewalOption ?? ""} onChange={(e) => set("etsyRenewalOption", e.target.value)}>
          <option value="">— not set —</option>
          <option value={EtsyRenewalOption.Automatic}>Automatic</option>
          <option value={EtsyRenewalOption.Manual}>Manual</option>
        </select>
      </Field>
      {check("etsyFeatured", "Feature this listing in my shop")}
      {check("etsyAdsOptIn", "Etsy Ads preference (never enabled by the ERP; manage in Etsy)")}
      {check("etsyRestockRequests", "Accept restock requests (API support to be verified)")}

      {sub("Legal & compliance (EU GPSR)", "seller-provided facts only - never filled automatically; required where EU product-safety rules apply")}
      {text("etsyGpsrManufacturerName", "Manufacturer name")}
      {area("etsyGpsrManufacturerAddress", "Manufacturer postal address")}
      {text("etsyGpsrManufacturerContact", "Manufacturer email or https:// URL")}
      {text("etsyGpsrResponsiblePersonName", "EU responsible person name (if manufacturer is outside the EU)")}
      {area("etsyGpsrResponsiblePersonAddress", "EU responsible person postal address")}
      {text("etsyGpsrResponsiblePersonContact", "EU responsible person email or https:// URL")}
      {area("etsyGpsrSafetyInformation", "Safety information and warnings")}
      {area("etsyConsumerGuaranteeInfo", "Applicable consumer guarantee information")}
    </div>
  );
}
