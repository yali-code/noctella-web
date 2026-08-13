"use client";

import {
  DIMENSION_UNIT_VALUES,
  LISTING_STATUS_VALUES,
  PRICE_CURRENCY_VALUES,
  PRODUCT_SHIPPING_PROFILE_VALUES,
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  PublishChannel,
  ProductStatus,
  ProductType,
  WEIGHT_UNIT_VALUES,
  type Category,
  type Collection,
  type Product,
} from "@noctella/shared";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { PaginatedResult, ProductDetail } from "@/lib/types";
import { AiChannelSuggestionsSection } from "./AiChannelSuggestionsSection";
import { MarketingTagsSection } from "./MarketingTagsSection";

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

  // Sprint 3: marketplace data foundation — all optional, not required to save
  ebayTitle?: string;
  ebaySubtitle?: string;
  ebayDescription?: string;
  ebayConditionDescription?: string;
  ebayCategory?: string;
  ebayItemSpecifics?: string;
  ebayListingPriceEur?: string;
  ebayListingStatus?: string;

  etsyTitle?: string;
  etsyDescription?: string;
  etsyTags?: string;
  etsyMaterials?: string;
  etsyStyle?: string;
  etsyOccasion?: string;
  etsyListingPriceEur?: string;
  etsyListingStatus?: string;

  wooProductName?: string;
  wooShortDescription?: string;
  wooLongDescription?: string;
  wooSlug?: string;
  wooSeoTitle?: string;
  wooMetaDescription?: string;
  wooFocusKeyword?: string;
  wooListingPriceEur?: string;
  wooListingStatus?: string;
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
    // Sprint 137: priceEur may be null (Draft/Approved Product with no sale price yet) - render
    // as a blank input, never crash, never fabricate a "0" that could be mistaken for a real price.
    priceEur: product.priceEur?.toString() ?? "",
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
    ebayTitle: product.ebayTitle,
    ebaySubtitle: product.ebaySubtitle,
    ebayDescription: product.ebayDescription,
    ebayConditionDescription: product.ebayConditionDescription,
    ebayCategory: product.ebayCategory,
    ebayItemSpecifics: product.ebayItemSpecifics,
    ebayListingPriceEur: product.ebayListingPriceEur?.toString(),
    ebayListingStatus: product.ebayListingStatus,
    etsyTitle: product.etsyTitle,
    etsyDescription: product.etsyDescription,
    etsyTags: product.etsyTags?.join(", "),
    etsyMaterials: product.etsyMaterials,
    etsyStyle: product.etsyStyle,
    etsyOccasion: product.etsyOccasion,
    etsyListingPriceEur: product.etsyListingPriceEur?.toString(),
    etsyListingStatus: product.etsyListingStatus,
    wooProductName: product.wooProductName,
    wooShortDescription: product.wooShortDescription,
    wooLongDescription: product.wooLongDescription,
    wooSlug: product.wooSlug,
    wooSeoTitle: product.wooSeoTitle,
    wooMetaDescription: product.wooMetaDescription,
    wooFocusKeyword: product.wooFocusKeyword,
    wooListingPriceEur: product.wooListingPriceEur?.toString(),
    wooListingStatus: product.wooListingStatus,
  };
}

function toApiPayload(values: ProductFormValues, initialValues: ProductFormValues) {
  const num = (v?: string) => (v !== undefined && v !== "" ? Number(v) : undefined);
  /**
   * Sprint 137 Required Fix Correction: priceEur and wooListingPriceEur are the two sales-price
   * fields that participate in the approved Noctella Web effective-price invariant
   * (`wooListingPriceEur ?? priceEur`) and are the only ones this form must be able to explicitly
   * clear. Comparing against the already-available `initialValues` prop (not a new touched/dirty
   * flag) distinguishes:
   *   - untouched (current === initial, including both blank) -> undefined (omit key, no-op)
   *   - explicitly cleared (current is blank, differs from a non-blank initial) -> null
   *   - a real value -> the number
   * This also preserves current Create-mode semantics for free: initialValues.priceEur is always
   * "" on a fresh create form, so a field the user never touches (or types into and blanks again)
   * stays "untouched" and is omitted, exactly as before.
   * eBay/Etsy listing-price overrides are NOT part of this invariant and are left on the
   * pre-existing `num()` no-op-on-blank behavior (out of scope for this correction).
   */
  const salesPrice = (current?: string, initial?: string): number | null | undefined => {
    const c = current ?? "";
    const i = initial ?? "";
    if (c === i) return undefined;
    if (c === "") return null;
    return Number(c);
  };
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
    priceEur: salesPrice(values.priceEur, initialValues.priceEur),
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
    ebayTitle: values.ebayTitle || undefined,
    ebaySubtitle: values.ebaySubtitle || undefined,
    ebayDescription: values.ebayDescription || undefined,
    ebayConditionDescription: values.ebayConditionDescription || undefined,
    ebayCategory: values.ebayCategory || undefined,
    ebayItemSpecifics: values.ebayItemSpecifics || undefined,
    ebayListingPriceEur: num(values.ebayListingPriceEur),
    ebayListingStatus: values.ebayListingStatus || undefined,
    etsyTitle: values.etsyTitle || undefined,
    etsyDescription: values.etsyDescription || undefined,
    etsyTags: values.etsyTags
      ? values.etsyTags.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined,
    etsyMaterials: values.etsyMaterials || undefined,
    etsyStyle: values.etsyStyle || undefined,
    etsyOccasion: values.etsyOccasion || undefined,
    etsyListingPriceEur: num(values.etsyListingPriceEur),
    etsyListingStatus: values.etsyListingStatus || undefined,
    wooProductName: values.wooProductName || undefined,
    wooShortDescription: values.wooShortDescription || undefined,
    wooLongDescription: values.wooLongDescription || undefined,
    wooSlug: values.wooSlug || undefined,
    wooSeoTitle: values.wooSeoTitle || undefined,
    wooMetaDescription: values.wooMetaDescription || undefined,
    wooFocusKeyword: values.wooFocusKeyword || undefined,
    wooListingPriceEur: salesPrice(values.wooListingPriceEur, initialValues.wooListingPriceEur),
    wooListingStatus: values.wooListingStatus || undefined,
    images: values.imageUrl
      ? [{ url: values.imageUrl, altText: values.imageAltText || undefined, sortOrder: 0, isPrimary: true }]
      : [],
  };
}

interface ProductFormProps {
  initialValues: ProductFormValues;
  submitLabel: string;
  onSubmit: (payload: ReturnType<typeof toApiPayload>) => Promise<void>;
  /**
   * Sprint 88: invoked only when the user explicitly clicks the version-conflict
   * reload action - never called automatically. EditProductPage owns what
   * "reload" means (a full page reload is acceptable if that is the smallest
   * reliable behavior for the current Client Component structure).
   */
  onVersionConflictReload?: () => void;
  /**
   * Sprint 144: the canonical Product Edit foundation. Supplied only by
   * products/[id]/edit/page.tsx (an existing Product); products/new/page.tsx never supplies it.
   * Its presence, not the current `values.status`, is what this form treats as "editing an
   * existing Product" - it gates two things: locking the SKU field to read-only (SKU is
   * system-generated and must never be retyped once a Product exists), and mounting the
   * Marketing Tags section (which requires a real Product id and must never be mounted, nor call
   * the Marketing Tags API, for a Product that does not exist yet).
   */
  productId?: string;
  /**
   * Sprint 145: the current canonical Product version, mirroring EditProductPage's own existing
   * Sprint 88 `expectedUpdatedAt` - used only as the client-side staleness hint for the new AI
   * Suggestions sections below (never as an alternative concurrency mechanism; the approve
   * endpoint's own server-side freshness checks remain sole authority).
   */
  productUpdatedAt?: string;
  /**
   * Sprint 145: fired only after a successful inline Marketplace Preparation Approve, with the
   * exact updatedAt the approve endpoint returned. EditProductPage uses this to advance its own
   * `expectedUpdatedAt` so a later Save Changes is never rejected as a false version conflict.
   */
  onProductVersionAdvanced?: (updatedAt: string) => void;
}

/** Sprint 145: exactly the ProductFormValues keys each channel's Marketplace Preparation Approve is allowed to have written - mirrors mapApprovedFieldsToProductValues (use-cases/marketplace-preparation/useCases.ts) exactly, never Core/SKU/stock/price/status/other-channel fields. */
const AI_CHANNEL_FIELD_KEYS: Record<PublishChannel, Array<keyof ProductFormValues>> = {
  [PublishChannel.Ebay]: ["ebayTitle", "ebayDescription", "ebayConditionDescription", "ebayItemSpecifics"],
  [PublishChannel.Etsy]: ["etsyTitle", "etsyDescription", "etsyTags", "etsyMaterials", "etsyStyle", "etsyOccasion"],
  [PublishChannel.NoctellaWeb]: ["wooProductName", "wooLongDescription", "wooShortDescription", "wooSeoTitle", "wooMetaDescription", "wooFocusKeyword"],
};

/** Maps a channel's owned ProductFormValues keys onto the corresponding field of the returned canonical Product (etsyTags is an array on Product, a comma-joined string in ProductFormValues - matches productToFormValues's own convention exactly). */
function readAiChannelFieldFromProduct(product: Product, key: keyof ProductFormValues): string | undefined {
  if (key === "etsyTags") return product.etsyTags?.join(", ") ?? "";
  const value = (product as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : (value ?? "") as string;
}

export function ProductForm({
  initialValues,
  submitLabel,
  onSubmit,
  onVersionConflictReload,
  productId,
  productUpdatedAt,
  onProductVersionAdvanced,
}: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>(initialValues);
  const [categories, setCategories] = useState<Category[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Sprint 145: mirrors `values`'s own "initialize once from props" convention - advanced only by
  // handleAiSuggestionsApplied below, never by re-reading the productUpdatedAt prop after mount
  // (EditProductPage never re-renders ProductForm with a new prop value while it stays mounted).
  const [currentProductUpdatedAt, setCurrentProductUpdatedAt] = useState(productUpdatedAt);

  /**
   * Sprint 145: the ONLY place a Marketplace Preparation Approve result is allowed to touch
   * `values` - merges exclusively the approved channel's own known field keys from the endpoint's
   * returned Product, leaving every other field (including any unsaved manual edit anywhere else
   * in this form) completely untouched. Also advances the local staleness baseline and notifies
   * EditProductPage so the next Save Changes uses the fresh version token.
   */
  function handleAiSuggestionsApplied(channel: PublishChannel, product: Product) {
    setValues((prev) => {
      const next = { ...prev };
      for (const key of AI_CHANNEL_FIELD_KEYS[channel]) {
        (next as Record<string, unknown>)[key] = readAiChannelFieldFromProduct(product, key);
      }
      return next;
    });
    setCurrentProductUpdatedAt(product.updatedAt);
    onProductVersionAdvanced?.(product.updatedAt);
  }

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
    setVersionConflict(false);
    try {
      await onSubmit(toApiPayload(values, initialValues));
    } catch (err) {
      if (err instanceof ApiError) {
        // Sprint 88: a version conflict is shown separately and never clears `values` or
        // resubmits/reloads on its own - the user must explicitly choose the reload action.
        if (err.code === "PRODUCT_VERSION_CONFLICT") {
          setVersionConflict(true);
        } else {
          setFormError(err.message);
          if (err.details) {
            const mapped: Record<string, string> = {};
            for (const d of err.details) mapped[d.path] = d.message;
            setFieldErrors(mapped);
          }
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
      {versionConflict && (
        <div role="alert" style={{ border: "1px solid #c86a6a", padding: 12, borderRadius: 4 }}>
          <p style={{ color: "#c86a6a", margin: 0 }}>
            This product changed after you opened it. No local changes were written.
          </p>
          {onVersionConflictReload && (
            <button type="button" onClick={onVersionConflictReload} style={{ marginTop: 8 }}>
              Reload Latest Product
            </button>
          )}
        </div>
      )}
      {formError && <p style={{ color: "#c86a6a" }}>{formError}</p>}

      <Section title="Core">
        <Field label="Title" error={fieldErrors.title}>
          <input style={inputStyle} value={values.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="SKU" error={fieldErrors.sku}>
          {/* Sprint 144: SKU is system-generated (sequential NOC-000001 format) and is also the
              barcode payload itself - once a Product exists (productId supplied), it must never be
              manually retyped here. `title` carries the explanation as a tooltip rather than a
              second text node inside the <label>, which would otherwise be folded into this
              field's accessible name by getByLabelText/assistive tech. */}
          {productId ? (
            <input
              style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
              value={values.sku}
              disabled
              readOnly
              title="SKU is system-generated and cannot be changed."
            />
          ) : (
            <input style={inputStyle} value={values.sku} onChange={(e) => set("sku", e.target.value)} />
          )}
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
          {/* Sprint 144: Published means a successful Noctella Web storefront publication - it must
              never be fabricated or downgraded by a generic Product edit. When the current status
              is already Published, this form preserves it unchanged (locked, read-only); only the
              authoritative publish workflow may set or change it. `title` carries the explanation
              as a tooltip rather than a second text node inside the <label>, which would otherwise
              be folded into this field's accessible name by getByLabelText/assistive tech. */}
          {values.status === ProductStatus.Published ? (
            <input
              style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
              value={values.status}
              disabled
              readOnly
              title="Published reflects a successful Noctella Web publication and is managed by the publish workflow."
            />
          ) : (
            <select style={inputStyle} value={values.status} onChange={(e) => set("status", e.target.value)}>
              {/* Sprint 144: Published is deliberately excluded here - it must never be selectable
                  as an ordinary generic status transition from this form; it is only ever produced
                  by the authoritative publish workflow (executePublish). */}
              {PRODUCT_STATUS_VALUES.filter((s) => s !== ProductStatus.Published).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
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
          <input style={inputStyle} value={values.priceEur ?? ""} onChange={(e) => set("priceEur", e.target.value)} />
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
        <Field label="Shipping Profile">
          <select
            style={inputStyle}
            value={values.shippingProfile ?? ""}
            onChange={(e) => set("shippingProfile", e.target.value || undefined)}
          >
            <option value="">Standard (default)</option>
            {PRODUCT_SHIPPING_PROFILE_VALUES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
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

      <Section title="eBay (optional — not published or synced yet)">
        <Field label="Title">
          <input style={inputStyle} value={values.ebayTitle ?? ""} onChange={(e) => set("ebayTitle", e.target.value)} />
        </Field>
        <Field label="Subtitle">
          <input
            style={inputStyle}
            value={values.ebaySubtitle ?? ""}
            onChange={(e) => set("ebaySubtitle", e.target.value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={values.ebayDescription ?? ""}
            onChange={(e) => set("ebayDescription", e.target.value)}
          />
        </Field>
        <Field label="Condition Description">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.ebayConditionDescription ?? ""}
            onChange={(e) => set("ebayConditionDescription", e.target.value)}
          />
        </Field>
        <Field label="Category">
          <input
            style={inputStyle}
            value={values.ebayCategory ?? ""}
            onChange={(e) => set("ebayCategory", e.target.value)}
          />
        </Field>
        <Field label="Item Specifics">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.ebayItemSpecifics ?? ""}
            onChange={(e) => set("ebayItemSpecifics", e.target.value)}
          />
        </Field>
        <Field label="Listing Price (EUR)">
          <input
            style={inputStyle}
            value={values.ebayListingPriceEur ?? ""}
            onChange={(e) => set("ebayListingPriceEur", e.target.value)}
          />
        </Field>
        <Field label="Listing Status">
          <select
            style={inputStyle}
            value={values.ebayListingStatus ?? ""}
            onChange={(e) => set("ebayListingStatus", e.target.value)}
          >
            <option value="">—</option>
            {LISTING_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {/* Sprint 145: inline Marketplace Preparation AI assistance - only in edit mode (productId
            known); create mode never mounts this, so it never calls the Marketplace Preparation
            API for a Product that does not exist yet. */}
        {productId && (
          <AiChannelSuggestionsSection
            productId={productId}
            channel={PublishChannel.Ebay}
            productUpdatedAt={currentProductUpdatedAt}
            onApplied={handleAiSuggestionsApplied}
          />
        )}
      </Section>

      <Section title="Etsy (optional — not published or synced yet)">
        <Field label="Title">
          <input style={inputStyle} value={values.etsyTitle ?? ""} onChange={(e) => set("etsyTitle", e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={values.etsyDescription ?? ""}
            onChange={(e) => set("etsyDescription", e.target.value)}
          />
        </Field>
        <Field label="Tags (comma-separated)">
          <input style={inputStyle} value={values.etsyTags ?? ""} onChange={(e) => set("etsyTags", e.target.value)} />
        </Field>
        <Field label="Materials">
          <input
            style={inputStyle}
            value={values.etsyMaterials ?? ""}
            onChange={(e) => set("etsyMaterials", e.target.value)}
          />
        </Field>
        <Field label="Style">
          <input style={inputStyle} value={values.etsyStyle ?? ""} onChange={(e) => set("etsyStyle", e.target.value)} />
        </Field>
        <Field label="Occasion">
          <input
            style={inputStyle}
            value={values.etsyOccasion ?? ""}
            onChange={(e) => set("etsyOccasion", e.target.value)}
          />
        </Field>
        <Field label="Listing Price (EUR)">
          <input
            style={inputStyle}
            value={values.etsyListingPriceEur ?? ""}
            onChange={(e) => set("etsyListingPriceEur", e.target.value)}
          />
        </Field>
        <Field label="Listing Status">
          <select
            style={inputStyle}
            value={values.etsyListingStatus ?? ""}
            onChange={(e) => set("etsyListingStatus", e.target.value)}
          >
            <option value="">—</option>
            {LISTING_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {productId && (
          <AiChannelSuggestionsSection
            productId={productId}
            channel={PublishChannel.Etsy}
            productUpdatedAt={currentProductUpdatedAt}
            onApplied={handleAiSuggestionsApplied}
          />
        )}
      </Section>

      <Section title="WooCommerce (optional — not published or synced yet)">
        <Field label="Product Name">
          <input
            style={inputStyle}
            value={values.wooProductName ?? ""}
            onChange={(e) => set("wooProductName", e.target.value)}
          />
        </Field>
        <Field label="Short Description">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={values.wooShortDescription ?? ""}
            onChange={(e) => set("wooShortDescription", e.target.value)}
          />
        </Field>
        <Field label="Long Description">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={values.wooLongDescription ?? ""}
            onChange={(e) => set("wooLongDescription", e.target.value)}
          />
        </Field>
        <Field label="Slug">
          <input style={inputStyle} value={values.wooSlug ?? ""} onChange={(e) => set("wooSlug", e.target.value)} />
        </Field>
        <Field label="SEO Title">
          <input
            style={inputStyle}
            value={values.wooSeoTitle ?? ""}
            onChange={(e) => set("wooSeoTitle", e.target.value)}
          />
        </Field>
        <Field label="Meta Description">
          <input
            style={inputStyle}
            value={values.wooMetaDescription ?? ""}
            onChange={(e) => set("wooMetaDescription", e.target.value)}
          />
        </Field>
        <Field label="Focus Keyword">
          <input
            style={inputStyle}
            value={values.wooFocusKeyword ?? ""}
            onChange={(e) => set("wooFocusKeyword", e.target.value)}
          />
        </Field>
        <Field label="Listing Price (EUR)">
          <input
            style={inputStyle}
            value={values.wooListingPriceEur ?? ""}
            onChange={(e) => set("wooListingPriceEur", e.target.value)}
          />
        </Field>
        <Field label="Listing Status">
          <select
            style={inputStyle}
            value={values.wooListingStatus ?? ""}
            onChange={(e) => set("wooListingStatus", e.target.value)}
          >
            <option value="">—</option>
            {LISTING_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {productId && (
          <AiChannelSuggestionsSection
            productId={productId}
            channel={PublishChannel.NoctellaWeb}
            productUpdatedAt={currentProductUpdatedAt}
            onApplied={handleAiSuggestionsApplied}
          />
        )}
      </Section>

      {/* Sprint 144: Marketing Tags reuse the existing Sprint 140 API unchanged, only in edit mode
          (productId known) - create mode never mounts this section, so it never calls the
          Marketing Tags API for a Product that does not exist yet. Distinct from the per-channel
          Etsy tags edited above. */}
      {productId && (
        <Section title="Marketing Tags">
          <MarketingTagsSection productId={productId} />
        </Section>
      )}

      <Section title="AI Drafts">
        {/* Sprint 145 correction: Marketplace Preparation AI Suggestions are now available directly
            in the eBay/Etsy/Noctella Web sections above. AI Product Intake (Product creation) and
            the separate AI Drafts review screen remain their own dedicated surfaces. */}
        <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          AI Suggestions for eBay, Etsy, and Noctella Web are available directly in their sections
          above. AI Product Intake and AI Drafts remain separate screens.
        </p>
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
