"use client";

import {
  DIMENSION_UNIT_VALUES,
  PRICE_CURRENCY_VALUES,
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  ProductType,
  WEIGHT_UNIT_VALUES,
  type Category,
  type Collection,
} from "@noctella/shared";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { PaginatedResult, ProductDetail } from "@/lib/types";

export interface ProductFormValues {
  sku: string;
  title: string;
  slug?: string;
  type: string;
  status: string;
  categoryId: string;
  collectionId?: string;

  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  description?: string;
  productStory?: string;
  condition?: string;
  conditionDescription?: string;

  lengthValue?: string;
  widthValue?: string;
  heightValue?: string;
  dimensionUnit?: string;
  weightValue?: string;
  weightUnit?: string;

  stockQuantity?: string;
  lotItemCount?: string;
  purchaseCost?: string;
  purchaseCurrency?: string;
  internalNotes?: string;

  priceEur: string;
  priceUsd?: string;
  minOfferPrice?: string;

  imageUrl?: string;
  imageAltText?: string;
  videoUrl?: string;

  shippingProfile?: string;
  shippingNote?: string;
  customsWarning: boolean;

  seoTitle?: string;
  metaDescription?: string;
  keywords?: string;

  isFeatured: boolean;
  allowMakeOffer: boolean;
  allowCashOnDelivery: boolean;
  showInArchiveAfterSale: boolean;
}

export const emptyProductForm: ProductFormValues = {
  sku: "",
  title: "",
  type: ProductType.UniqueItem,
  status: "draft",
  categoryId: "",
  customsWarning: false,
  isFeatured: false,
  allowMakeOffer: false,
  allowCashOnDelivery: false,
  showInArchiveAfterSale: false,
  priceEur: "",
};

export function productToFormValues(product: ProductDetail): ProductFormValues {
  const primaryImage = product.images.find((img) => img.isPrimary) ?? product.images[0];
  return {
    sku: product.sku,
    title: product.title,
    slug: product.slug,
    type: product.type,
    status: product.status,
    categoryId: product.categoryId ?? "",
    collectionId: product.collectionId,
    brand: product.brand,
    model: product.model,
    manufacturer: product.manufacturer,
    countryOfOrigin: product.countryOfOrigin,
    period: product.period,
    materials: product.materials,
    description: product.description,
    productStory: product.productStory,
    condition: product.condition,
    conditionDescription: product.conditionDescription,
    lengthValue: product.lengthValue?.toString(),
    widthValue: product.widthValue?.toString(),
    heightValue: product.heightValue?.toString(),
    dimensionUnit: product.dimensionUnit,
    weightValue: product.weightValue?.toString(),
    weightUnit: product.weightUnit,
    stockQuantity: product.stockQuantity?.toString(),
    lotItemCount: product.lotItemCount?.toString(),
    purchaseCost: product.purchaseCost?.toString(),
    purchaseCurrency: product.purchaseCurrency,
    internalNotes: product.internalNotes,
    priceEur: product.priceEur.toString(),
    priceUsd: product.priceUsd?.toString(),
    minOfferPrice: product.minOfferPrice?.toString(),
    imageUrl: primaryImage?.url,
    imageAltText: primaryImage?.altText,
    videoUrl: product.videoUrl,
    shippingProfile: product.shippingProfile,
    shippingNote: product.shippingNote,
    customsWarning: product.customsWarning,
    seoTitle: product.seoTitle,
    metaDescription: product.metaDescription,
    keywords: product.keywords?.join(", "),
    isFeatured: product.isFeatured,
    allowMakeOffer: product.allowMakeOffer,
    allowCashOnDelivery: product.allowCashOnDelivery,
    showInArchiveAfterSale: product.showInArchiveAfterSale,
  };
}

function toApiPayload(values: ProductFormValues) {
  const num = (v?: string) => (v !== undefined && v !== "" ? Number(v) : undefined);
  return {
    sku: values.sku,
    title: values.title,
    slug: values.slug || undefined,
    type: values.type,
    status: values.status,
    categoryId: values.categoryId,
    collectionId: values.collectionId || undefined,
    brand: values.brand || undefined,
    model: values.model || undefined,
    manufacturer: values.manufacturer || undefined,
    countryOfOrigin: values.countryOfOrigin || undefined,
    period: values.period || undefined,
    materials: values.materials || undefined,
    description: values.description || undefined,
    productStory: values.productStory || undefined,
    condition: values.condition || undefined,
    conditionDescription: values.conditionDescription || undefined,
    lengthValue: num(values.lengthValue),
    widthValue: num(values.widthValue),
    heightValue: num(values.heightValue),
    dimensionUnit: values.dimensionUnit || undefined,
    weightValue: num(values.weightValue),
    weightUnit: values.weightUnit || undefined,
    stockQuantity: num(values.stockQuantity),
    lotItemCount: num(values.lotItemCount),
    purchaseCost: num(values.purchaseCost),
    purchaseCurrency: values.purchaseCurrency || undefined,
    internalNotes: values.internalNotes || undefined,
    priceEur: num(values.priceEur),
    priceUsd: num(values.priceUsd),
    minOfferPrice: num(values.minOfferPrice),
    videoUrl: values.videoUrl || undefined,
    shippingProfile: values.shippingProfile || undefined,
    shippingNote: values.shippingNote || undefined,
    customsWarning: values.customsWarning,
    seoTitle: values.seoTitle || undefined,
    metaDescription: values.metaDescription || undefined,
    keywords: values.keywords
      ? values.keywords.split(",").map((k) => k.trim()).filter(Boolean)
      : undefined,
    isFeatured: values.isFeatured,
    allowMakeOffer: values.allowMakeOffer,
    allowCashOnDelivery: values.allowCashOnDelivery,
    showInArchiveAfterSale: values.showInArchiveAfterSale,
    images: values.imageUrl
      ? [{ url: values.imageUrl, altText: values.imageAltText || undefined, sortOrder: 0, isPrimary: true }]
      : [],
  };
}

interface ProductFormProps {
  initialValues: ProductFormValues;
  submitLabel: string;
  onSubmit: (payload: ReturnType<typeof toApiPayload>) => Promise<void>;
}

export function ProductForm({ initialValues, submitLabel, onSubmit }: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>(initialValues);
  const [categories, setCategories] = useState<Category[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
    api
      .get<PaginatedResult<Collection>>("/api/collections?pageSize=100")
      .then((res) => setCollections(res.items))
      .catch(() => {});
  }, []);

  function set<K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      await onSubmit(toApiPayload(values));
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        if (err.details) {
          const mapped: Record<string, string> = {};
          for (const d of err.details) mapped[d.path] = d.message;
          setFieldErrors(mapped);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 780 }}>
      {formError && <p style={{ color: "#c86a6a" }}>{formError}</p>}

      <Section title="Core">
        <Field label="Title" error={fieldErrors.title}>
          <input style={inputStyle} value={values.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="SKU" error={fieldErrors.sku}>
          <input style={inputStyle} value={values.sku} onChange={(e) => set("sku", e.target.value)} />
        </Field>
        <Field label="Slug (optional, derived from title if blank)">
          <input style={inputStyle} value={values.slug ?? ""} onChange={(e) => set("slug", e.target.value)} />
        </Field>
        <Field label="Product Type" error={fieldErrors.type}>
          <select style={inputStyle} value={values.type} onChange={(e) => set("type", e.target.value)}>
            {PRODUCT_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" error={fieldErrors.status}>
          <select style={inputStyle} value={values.status} onChange={(e) => set("status", e.target.value)}>
            {PRODUCT_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category" error={fieldErrors.categoryId}>
          <select
            style={inputStyle}
            value={values.categoryId}
            onChange={(e) => set("categoryId", e.target.value)}
          >
            <option value="">Select a category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Collection (optional)">
          <select
            style={inputStyle}
            value={values.collectionId ?? ""}
            onChange={(e) => set("collectionId", e.target.value)}
          >
            <option value="">None</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Product Details">
        <Field label="Brand">
          <input style={inputStyle} value={values.brand ?? ""} onChange={(e) => set("brand", e.target.value)} />
        </Field>
        <Field label="Model">
          <input style={inputStyle} value={values.model ?? ""} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Manufacturer">
          <input
            style={inputStyle}
            value={values.manufacturer ?? ""}
            onChange={(e) => set("manufacturer", e.target.value)}
          />
        </Field>
        <Field label="Country of Origin">
          <input
            style={inputStyle}
            value={values.countryOfOrigin ?? ""}
            onChange={(e) => set("countryOfOrigin", e.target.value)}
          />
        </Field>
        <Field label="Period / Estimated Production Date">
          <input style={inputStyle} value={values.period ?? ""} onChange={(e) => set("period", e.target.value)} />
        </Field>
        <Field label="Materials">
          <input
            style={inputStyle}
            value={values.materials ?? ""}
            onChange={(e) => set("materials", e.target.value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={values.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <Field label="Product Story">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={values.productStory ?? ""}
            onChange={(e) => set("productStory", e.target.value)}
          />
        </Field>
        <Field label="Condition">
          <input
            style={inputStyle}
            value={values.condition ?? ""}
            onChange={(e) => set("condition", e.target.value)}
          />
        </Field>
        <Field label="Condition Description">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.conditionDescription ?? ""}
            onChange={(e) => set("conditionDescription", e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Physical Information">
        <Field label="Length" error={fieldErrors.lengthValue}>
          <input style={inputStyle} value={values.lengthValue ?? ""} onChange={(e) => set("lengthValue", e.target.value)} />
        </Field>
        <Field label="Width" error={fieldErrors.widthValue}>
          <input style={inputStyle} value={values.widthValue ?? ""} onChange={(e) => set("widthValue", e.target.value)} />
        </Field>
        <Field label="Height" error={fieldErrors.heightValue}>
          <input style={inputStyle} value={values.heightValue ?? ""} onChange={(e) => set("heightValue", e.target.value)} />
        </Field>
        <Field label="Dimension Unit">
          <select
            style={inputStyle}
            value={values.dimensionUnit ?? ""}
            onChange={(e) => set("dimensionUnit", e.target.value)}
          >
            <option value="">—</option>
            {DIMENSION_UNIT_VALUES.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Weight" error={fieldErrors.weightValue}>
          <input style={inputStyle} value={values.weightValue ?? ""} onChange={(e) => set("weightValue", e.target.value)} />
        </Field>
        <Field label="Weight Unit">
          <select
            style={inputStyle}
            value={values.weightUnit ?? ""}
            onChange={(e) => set("weightUnit", e.target.value)}
          >
            <option value="">—</option>
            {WEIGHT_UNIT_VALUES.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Inventory">
        <Field
          label={
            values.type === ProductType.UniqueItem
              ? "Stock Quantity (Unique Item — max 1)"
              : "Stock Quantity (Lot listing — normally 1)"
          }
          error={fieldErrors.stockQuantity}
        >
          <input
            style={inputStyle}
            value={values.stockQuantity ?? ""}
            onChange={(e) => set("stockQuantity", e.target.value)}
          />
        </Field>
        {values.type === ProductType.LotItem && (
          <Field label="Lot Item Count (informational)">
            <input
              style={inputStyle}
              value={values.lotItemCount ?? ""}
              onChange={(e) => set("lotItemCount", e.target.value)}
            />
          </Field>
        )}
        <Field label="Purchase Cost" error={fieldErrors.purchaseCost}>
          <input
            style={inputStyle}
            value={values.purchaseCost ?? ""}
            onChange={(e) => set("purchaseCost", e.target.value)}
          />
        </Field>
        <Field label="Purchase Currency">
          <select
            style={inputStyle}
            value={values.purchaseCurrency ?? ""}
            onChange={(e) => set("purchaseCurrency", e.target.value)}
          >
            <option value="">—</option>
            {PRICE_CURRENCY_VALUES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Internal Notes">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.internalNotes ?? ""}
            onChange={(e) => set("internalNotes", e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Pricing">
        <Field label="EUR Price" error={fieldErrors.priceEur}>
          <input style={inputStyle} value={values.priceEur} onChange={(e) => set("priceEur", e.target.value)} />
        </Field>
        <Field label="USD Price">
          <input style={inputStyle} value={values.priceUsd ?? ""} onChange={(e) => set("priceUsd", e.target.value)} />
        </Field>
        <Field label="Minimum Offer Price">
          <input
            style={inputStyle}
            value={values.minOfferPrice ?? ""}
            onChange={(e) => set("minOfferPrice", e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Media">
        <Field label="Primary Image URL">
          <input style={inputStyle} value={values.imageUrl ?? ""} onChange={(e) => set("imageUrl", e.target.value)} />
        </Field>
        <Field label="Image Alt Text">
          <input
            style={inputStyle}
            value={values.imageAltText ?? ""}
            onChange={(e) => set("imageAltText", e.target.value)}
          />
        </Field>
        <Field label="Video URL">
          <input style={inputStyle} value={values.videoUrl ?? ""} onChange={(e) => set("videoUrl", e.target.value)} />
        </Field>
      </Section>

      <Section title="Shipping">
        <Field label="Shipping Profile (placeholder)">
          <input
            style={inputStyle}
            value={values.shippingProfile ?? ""}
            onChange={(e) => set("shippingProfile", e.target.value)}
          />
        </Field>
        <Field label="Shipping Note">
          <input
            style={inputStyle}
            value={values.shippingNote ?? ""}
            onChange={(e) => set("shippingNote", e.target.value)}
          />
        </Field>
        <Checkbox
          label="Show customs / import-duty warning"
          checked={values.customsWarning}
          onChange={(v) => set("customsWarning", v)}
        />
      </Section>

      <Section title="SEO">
        <Field label="SEO Title">
          <input style={inputStyle} value={values.seoTitle ?? ""} onChange={(e) => set("seoTitle", e.target.value)} />
        </Field>
        <Field label="Meta Description">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.metaDescription ?? ""}
            onChange={(e) => set("metaDescription", e.target.value)}
          />
        </Field>
        <Field label="Keywords (comma-separated)">
          <input style={inputStyle} value={values.keywords ?? ""} onChange={(e) => set("keywords", e.target.value)} />
        </Field>
      </Section>

      <Section title="Website Options">
        <Checkbox label="Featured product" checked={values.isFeatured} onChange={(v) => set("isFeatured", v)} />
        <Checkbox
          label="Allow Make an Offer"
          checked={values.allowMakeOffer}
          onChange={(v) => set("allowMakeOffer", v)}
        />
        <Checkbox
          label="Allow Cash on Delivery"
          checked={values.allowCashOnDelivery}
          onChange={(v) => set("allowCashOnDelivery", v)}
        />
        <Checkbox
          label="Show in Archive after sale"
          checked={values.showInArchiveAfterSale}
          onChange={(v) => set("showInArchiveAfterSale", v)}
        />
      </Section>

      <button
        type="submit"
        disabled={submitting}
        style={{
          alignSelf: "flex-start",
          padding: "12px 28px",
          background: "var(--noctella-antique-gold)",
          color: "var(--noctella-night-navy)",
          border: "none",
          borderRadius: 4,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {submitting ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: 20 }}>
      <legend style={{ padding: "0 8px", color: "var(--noctella-bright-star-gold)", fontFamily: "var(--font-display)" }}>
        {title}
      </legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
    </fieldset>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      {children}
      {error && <span style={{ color: "#c86a6a", fontSize: 12 }}>{error}</span>}
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
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
