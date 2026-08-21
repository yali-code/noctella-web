import { AdminRole } from "../enums/adminRole";
import { ProductStatus } from "../enums/productStatus";
import { ProductType } from "../enums/productType";
import { DimensionUnit } from "../enums/dimensionUnit";
import { WeightUnit } from "../enums/weightUnit";
import { PriceCurrency } from "../enums/priceCurrency";
import { ListingStatus } from "../enums/listingStatus";
import { PublishChannel } from "../enums/publishChannel";
import { MarketplacePreparationStatus } from "../enums/marketplacePreparationStatus";
import { CanonicalProductProposalStatus } from "../enums/canonicalProductProposalStatus";
import { AiDraftStatus } from "../enums/aiDraftStatus";
import { AiProductIntakeStatus } from "../enums/aiProductIntakeStatus";
import { AiIntakeFieldDecision } from "../enums/aiIntakeFieldDecision";
import { OfferStatus } from "../enums/offerStatus";
import { PaymentProvider } from "../enums/paymentProvider";
import { PaymentStatus } from "../enums/paymentStatus";
import { OrderStatus } from "../enums/orderStatus";
import { StockMovementType } from "../enums/stockMovementType";

export type ID = string;

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}

/** Base account shared by any authenticated identity. */
export interface User extends Timestamps {
  id: ID;
  email: string;
  passwordHash?: string;
  isActive: boolean;
}

export interface AdminUser extends User {
  roleId: ID;
  role?: AdminRole;
  displayName: string;
}

export interface Role extends Timestamps {
  id: ID;
  name: AdminRole;
  description?: string;
}

/** Customer auth foundation: password optional to support guest checkout. */
export interface Customer extends Timestamps {
  id: ID;
  email: string;
  passwordHash?: string;
  isGuest: boolean;
  firstName?: string;
  lastName?: string;
  googleId?: string;
  facebookId?: string;
}

export interface Category extends Timestamps {
  id: ID;
  name: string;
  slug: string;
  description?: string;
  parentId?: ID;
  displayImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
  displayOrder: number;
  isActive: boolean;
}

export interface Collection extends Timestamps {
  id: ID;
  name: string;
  slug: string;
  description?: string;
  coverImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
  displayOrder: number;
  isActive: boolean;
}

export interface ProductPhoto extends Timestamps {
  id: ID;
  productId: ID;
  url: string;
  thumbnailUrl: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  processingStatus?: "Processing" | "Ready" | "Failed";
  storageKey?: string | null;
  thumbnailStorageKey?: string | null;
  processingErrorCode?: string | null;
  processingUpdatedAt?: string | null;
}

export interface ProductImage extends Timestamps {
  id: ID;
  productId: ID;
  url: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
}

export interface Product extends Timestamps {
  id: ID;
  erpReferenceId?: ID;

  // Core
  sku: string;
  title: string;
  slug: string;
  type: ProductType;
  status: ProductStatus;
  /** Independent emergency sales block; Product.status retains its lifecycle meaning. */
  salePausedAt?: string;
  categoryId?: ID;
  collectionId?: ID;

  // Product details
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

  // Physical information
  lengthValue?: number;
  widthValue?: number;
  heightValue?: number;
  dimensionUnit?: DimensionUnit;
  weightValue?: number;
  weightUnit?: WeightUnit;

  // Inventory
  stockQuantity: number;
  lotItemCount?: number;
  purchaseCost?: number;
  purchaseCurrency?: PriceCurrency;
  internalNotes?: string;

  // Pricing
  /**
   * Sprint 137: nullable - a Product may exist physically in Stock (Draft) or be
   * Admin-approved (Approved) before its sale price has been determined. Never null
   * for a Published Product; publish validation is the sole authoritative gate that
   * enforces this before any publish transition.
   */
  priceEur: number | null;
  priceUsd?: number;
  minOfferPrice?: number;

  // Media
  videoUrl?: string;

  // Shipping
  shippingProfile?: string;
  shippingNote?: string;
  customsWarning: boolean;

  // SEO
  seoTitle?: string;
  metaDescription?: string;
  keywords?: string[];

  // Website options
  isFeatured: boolean;
  allowMakeOffer: boolean;
  allowCashOnDelivery: boolean;
  showInArchiveAfterSale: boolean;

  // eBay marketplace data (Sprint 3 foundation — all optional, not published/synced yet)
  ebayTitle?: string;
  ebaySubtitle?: string;
  ebayDescription?: string;
  ebayConditionDescription?: string;
  ebayCategory?: string;
  ebayItemSpecifics?: string;
  ebayListingPriceEur?: number;
  ebayListingStatus?: ListingStatus;

  // Etsy marketplace data (Sprint 3 foundation — all optional, not published/synced yet)
  etsyTitle?: string;
  etsyDescription?: string;
  etsyTags?: string[];
  etsyMaterials?: string;
  etsyStyle?: string;
  etsyOccasion?: string;
  etsyListingPriceEur?: number;
  etsyListingStatus?: ListingStatus;

  // WooCommerce marketplace data (Sprint 3 foundation — all optional, not published/synced yet)
  wooProductName?: string;
  wooShortDescription?: string;
  wooLongDescription?: string;
  wooSlug?: string;
  wooSeoTitle?: string;
  wooMetaDescription?: string;
  wooFocusKeyword?: string;
  wooListingPriceEur?: number;
  wooListingStatus?: ListingStatus;
}

/** Missing-field readiness report for one marketplace. Never blocks product save. */
export interface MarketplaceReadiness {
  ready: boolean;
  missingFields: string[];
}

export interface ProductMarketplaceReadiness {
  ebay: MarketplaceReadiness;
  etsy: MarketplaceReadiness;
  woocommerce: MarketplaceReadiness;
}

export interface Address {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  /** Sprint 134: additive, optional 2-letter ISO country code - authoritative for shipping-method country eligibility when present. Absent on any address predating this field. */
  countryCode?: string;
  phone?: string;
}

export interface Order extends Timestamps {
  id: ID;
  orderNumber: string;
  customerId?: ID;
  guestEmail: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentProvider?: PaymentProvider;
  subtotalAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  currency: PriceCurrency;
  orderDraftId?: string;
  offerId?: string;
  paymentReference?: string;
  billingAddress: Address;
  shippingAddress: Address;
  notes?: string;
  /** Sprint 134: immutable checkout-time shipping-method snapshot - null when shippingAmount was resolved without a configured shipping method (legacy/bootstrap state). Never a live reference; renaming/disabling the shipping method later never changes this. */
  shippingMethodId?: string;
  shippingMethodLabel?: string;
}

export interface OrderItem extends Timestamps {
  id: ID;
  orderId: ID;
  productId: ID;
  productSku: string;
  productTitle: string;
  productSlug: string;
  productType: ProductType;
  productImageUrl?: string;
  quantity: 1;
  unitPrice: number;
  totalPrice: number;
  currency: PriceCurrency;
}

/** AI-generated listing draft, reviewed by an admin before its values are approved onto the product. */
export interface AiListingDraft extends Timestamps {
  id: ID;
  productId: ID;
  status: AiDraftStatus;

  generatedTitle?: string;
  generatedDescription?: string;
  generatedStory?: string;
  generatedConditionDescription?: string;

  suggestedCategoryId?: ID;
  suggestedCollectionId?: ID;
  suggestedEurPrice?: number;
  suggestedUsdPrice?: number;
  suggestedMinimumOfferPrice?: number;

  seoTitle?: string;
  metaDescription?: string;
  keywords?: string[];

  shippingNote?: string;
  customsWarning?: boolean;

  aiConfidenceScore?: number;
  aiModel?: string;
  generationPromptVersion?: string;

  /**
   * Sprint 89: the Product.updatedAt observed at generation time - the
   * durable baseline used as expectedUpdatedAt at approval, so approval can
   * detect a Product change that happened after this draft was generated.
   * Null only for legacy rows generated before this field existed; those
   * cannot be approved and must be regenerated.
   */
  baseProductUpdatedAt?: string;

  rejectionReason?: string;
  reviewedByAdminUserId?: ID;
  reviewedAt?: string;
}

/**
 * Sprint 90: intake foundation only. No staged photos, provider payloads, or
 * generated field proposals belong on this aggregate - those are owned by
 * later sprints (91-95) and layered on top of this record via its id.
 */
export interface AiProductIntake extends Timestamps {
  id: ID;
  status: AiProductIntakeStatus;
  createdByAdminUserId: ID;

  /** Null until a Sprint 94 apply transaction sets it; immutable once set. */
  resultProductId?: ID;

  cancelledAt?: string;
  cancelledByAdminUserId?: ID;
  cancellationReason?: string;

  /** Sprint 94: set exactly once, together with resultProductId, when status transitions to Applied. */
  appliedAt?: string;
  appliedByAdminUserId?: ID;

  /** Sprint 95: set exactly once, when status transitions to Finalized. */
  finalizedAt?: string;
  finalizedByAdminUserId?: ID;
}

/**
 * Sprint 91: a private staged photo attached to an AiProductIntake, before any
 * Product exists. Fully independent of ProductPhoto - promotion into a
 * canonical ProductPhoto is a later sprint's concern, not modeled here.
 */
export interface AiIntakePhoto extends Timestamps {
  id: ID;
  intakeId: ID;
  storageKey: string;
  originalFilename: string;
  createdByAdminUserId: ID;
}

/**
 * Sprint 93: one independently-reviewed field on an AiProductIntake's
 * current proposal. `suggestion` is the AI's output for this field and is
 * never mutated by a review decision (even Rejected retains it). `value` is
 * the durable, explicitly-stored final value - populated only when
 * `decision` is Accepted (a snapshot copy of `suggestion` taken at accept
 * time, not derived dynamically) or Edited (the human-provided value);
 * always null for Pending and Rejected.
 */
export interface AiIntakeReviewedField<T> {
  suggestion: T | null;
  decision: AiIntakeFieldDecision;
  value: T | null;
  reviewedByAdminUserId: ID | null;
  reviewedAt: string | null;
}

/**
 * Sprint 93: the durable, current (one-per-intake) generated proposal and
 * its field-by-field review state. `stale` is computed at read time by
 * comparing the stored photo_set_fingerprint against the intake's current
 * staged photos - never persisted as a mutable boolean.
 */
export interface AiIntakeProposalReview extends Timestamps {
  id: ID;
  intakeId: ID;
  title: AiIntakeReviewedField<string>;
  description: AiIntakeReviewedField<string>;
  keywords: AiIntakeReviewedField<string[]>;
  confidenceScore?: number;
  /**
   * Sprint 106: expanded AI Full Product Analysis suggestions - flat,
   * direct-value fields (unlike title/description/keywords above), mirroring
   * confidenceScore's own existing precedent as a non-per-field-reviewed
   * suggestion. Reviewed/edited as a whole by the admin at Stock Acceptance
   * time, not through the per-field Accept/Edit/Reject/Pending mechanism.
   * Absent/undefined whenever the AI could not reliably determine a value -
   * never a fabricated placeholder.
   */
  suggestedCategoryId?: string;
  suggestedBrand?: string;
  suggestedModel?: string;
  suggestedManufacturer?: string;
  suggestedCountryOfOrigin?: string;
  suggestedPeriod?: string;
  suggestedMaterials?: string;
  suggestedCondition?: string;
  suggestedConditionDescription?: string;
  suggestedSeoTitle?: string;
  suggestedMetaDescription?: string;
  /** AI-suggested EUR price - a recommendation only, never authoritative; the admin must review/approve or edit it before Stock Acceptance. */
  suggestedPriceEur?: number;
  providerName: string;
  promptVersion: string;
  generatedAt: string;
  stale: boolean;
}

export interface Currency extends Timestamps {
  id: ID;
  code: string;
  symbol: string;
  isDefault: boolean;
}

export interface Setting extends Timestamps {
  id: ID;
  key: string;
  value: string;
}

/** Customer-submitted "Make an Offer" record. Never auto-accepted; reviewed manually later. */
export interface Offer extends Timestamps {
  id: ID;
  productId: ID;
  customerName: string;
  customerEmail: string;
  offeredAmount: number;
  currency: PriceCurrency;
  message?: string;
  status: OfferStatus;
}

/** Sprint 6A: payment foundation. No real provider connected yet — mock providers only. */
export interface Payment extends Timestamps {
  id: ID;
  orderDraftId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amount: number;
  currency: PriceCurrency;
}

export interface StockMovement extends Timestamps {
  id: ID;
  productId: ID;
  type: StockMovementType;
  quantityDelta: number;
  stockBefore: number;
  stockAfter: number;
  orderId?: ID;
  orderItemId?: ID;
  note?: string;
  createdByAdminUserId?: ID;
  idempotencyKey?: string;
}

export type PublishValidationIssueSeverity = "error" | "warning";

export type PublishValidationIssueType =
  | "missing_required_field"
  | "invalid_listing_status"
  | "inventory_unavailable"
  | "price_missing"
  | "content_warning"
  | "primary_product_photo_required";

export interface PublishValidationIssue {
  type: PublishValidationIssueType;
  severity: PublishValidationIssueSeverity;
  field?: string;
  message: string;
}

export interface PublishValidation {
  productId: ID;
  channel: PublishChannel;
  valid: boolean;
  errors: PublishValidationIssue[];
  warnings: PublishValidationIssue[];
}

export interface PublishPayload {
  productId: ID;
  channel: PublishChannel;
  listingStatus: ListingStatus;
  title: string;
  description: string;
  priceEur: number;
  category?: string;
  images: ProductImage[];
  metadata: Record<string, string | string[] | number | boolean | undefined>;
}

export interface PublishPreview {
  productId: ID;
  channel: PublishChannel;
  validation: PublishValidation;
  payload?: PublishPayload;
}

export enum MarketplaceConnectionStatus {
  Disconnected = "disconnected",
  Pending = "pending",
  Connected = "connected",
  Expired = "expired",
  Error = "error",
  Revoked = "revoked",
}

export enum PublishJobStatus {
  Pending = "pending",
  Processing = "processing",
  Succeeded = "succeeded",
  Failed = "failed",
  RetryPending = "retry_pending",
  Cancelled = "cancelled",
}

export type MarketplaceApiErrorType = "Validation" | "Authentication" | "Authorization" | "RateLimit" | "Timeout" | "Temporary" | "Permanent" | "Unknown";

export interface MarketplaceApiError { type: MarketplaceApiErrorType; code?: string; message: string; retryable: boolean; }
export interface MarketplaceCredentialMetadata { status: MarketplaceConnectionStatus; tokenExpiresAt?: string; scopes?: string[]; externalAccountId?: string; }
export interface MarketplaceConnection extends Timestamps { id: ID; channel: PublishChannel; accountLabel: string; externalAccountId?: string; tokenExpiresAt?: string; scopes?: string[]; status: MarketplaceConnectionStatus; lastError?: string; }
export interface PublishJob extends Timestamps { id: ID; productId: ID; channel: PublishChannel; status: PublishJobStatus; idempotencyKey: string; payloadSnapshot: PublishPayload; externalListingId?: string; externalListingUrl?: string; attemptCount: number; lastError?: string; completedAt?: string; }
export interface PublishAttempt { id: ID; publishJobId: ID; attemptNumber: number; requestSnapshot: unknown; responseSnapshot?: unknown; errorCode?: string; errorMessage?: string; createdAt: string; }
export interface ExternalListing { id: ID; productId: ID; channel: PublishChannel; connectionId: ID; externalListingId: string; externalListingUrl?: string; externalStatus: string; payloadSnapshot: PublishPayload; publishedAt: string; updatedAt: string; }
export type ProductLifecycleAction = "pause" | "relist";
export type ProductLifecycleOperationStatus = "processing" | "succeeded" | "partially_failed" | "failed";
export type ProductLifecycleTargetStatus = "pending" | "processing" | "succeeded" | "failed";
export interface ProductLifecycleTarget { key: string; channel: PublishChannel; kind: "local" | "external"; internalListingId?: ID; externalListingId?: string; connectionId?: ID; previousExternalStatus?: string; status: ProductLifecycleTargetStatus; processingStartedAt?: string; error?: string; retryable?: boolean; replacementExternalListingId?: string; }
export interface ProductLifecycleOperation extends Timestamps { id: ID; productId: ID; action: ProductLifecycleAction; status: ProductLifecycleOperationStatus; reason?: string; previousProductStatus: ProductStatus; targetSnapshot: ProductLifecycleTarget[]; targetResults: ProductLifecycleTarget[]; actorAdminUserId: ID; idempotencyKey: string; completedAt?: string; }
export interface ProductLifecycleResult { operation: ProductLifecycleOperation; productUpdatedAtBefore: string; productUpdatedAtAfter: string; }
export interface PublishExecutionResult { job: PublishJob; externalListing?: ExternalListing; attempts?: PublishAttempt[]; error?: MarketplaceApiError; }

/**
 * Sprint 141: one outcome entry per channel selected in a unified/batch publish request - never a
 * single global boolean, so a partial success (e.g. Web succeeded, Etsy failed) is always
 * representable truthfully. `result` carries the real PublishExecutionResult for "succeeded" and
 * for a "failed" outcome that actually reached a PublishJob (e.g. RetryPending/Failed after an
 * adapter error); it is absent for a "failed" outcome that never reached one (e.g. validation/
 * connection failure) and for the "skipped" (duplicate-active-listing / already-published) outcome,
 * which instead carries only `error` for display.
 */
export interface UnifiedPublishChannelResult {
  channel: PublishChannel;
  outcome: "succeeded" | "failed" | "skipped";
  result?: PublishExecutionResult;
  error?: { code?: string; message: string };
}

/** Sprint 141: the unified/batch publish response - one entry per selected channel, in request order. */
export interface UnifiedPublishResult {
  productId: ID;
  results: UnifiedPublishChannelResult[];
}

/**
 * Sprint 107: the in-flight, unapproved AI marketplace-preparation proposal
 * - one per (productId, channel). Never the destination of approved content
 * itself; approval copies admin-reviewed values onto the existing Product
 * marketplace-field columns (ebayTitle, etsyTags, wooProductName, etc. -
 * unchanged). Flat suggestion fields, mirroring AiIntakeProposalReview's own
 * confidenceScore/suggestedX precedent - not per-field Accept/Edit/Reject
 * tracked. baseProductUpdatedAt is the AI-Draft-proven staleness baseline.
 */
export interface MarketplacePreparation extends Timestamps {
  id: ID;
  productId: ID;
  channel: PublishChannel;
  status: MarketplacePreparationStatus;
  baseProductUpdatedAt: string;
  suggestedTitle?: string;
  suggestedDescription?: string;
  suggestedConditionDescription?: string;
  suggestedItemSpecifics?: string;
  suggestedTags?: string[];
  suggestedMaterials?: string;
  suggestedStyle?: string;
  suggestedOccasion?: string;
  suggestedShortDescription?: string;
  suggestedSeoTitle?: string;
  suggestedMetaDescription?: string;
  suggestedFocusKeyword?: string;
  providerName: string;
  promptVersion: string;
  generatedAt: string;
  appliedAt?: string;
  appliedByAdminUserId?: string;
}


/**
 * Sprint 140: the normalized Product Marketing Tag taxonomy - distinct from Product Category,
 * Collections, SEO keywords, and Etsy listing tags. `key` is the canonicalized machine key
 * (e.g. "fathers-day"); `label` is the admin-facing friendly text (e.g. "Father's Day").
 */
export interface MarketingTag extends Timestamps {
  id: ID;
  key: string;
  label: string;
}

/**
 * Sprint 148: the canonical (non-channel-scoped) fields a canonical Product AI proposal may
 * suggest a value for - Product Details, Physical Information, and Marketing Tags. Kept as `const`
 * tuples (not enums) so both the API's Zod allowlist and the Admin panel's rendering list read
 * from the exact same source, mirroring how DIMENSION_UNIT_VALUES/WEIGHT_UNIT_VALUES already do
 * this for their own enums. Deliberately excludes SKU, barcode, status, stock, purchase cost,
 * internal notes, category, collection, shipping, marketplace-channel, and publication fields -
 * see Sprint 148 Architecture Review's approved Product Details/Physical Information ownership.
 */
export const CANONICAL_PRODUCT_DETAIL_FIELD_KEYS = [
  "brand",
  "model",
  "manufacturer",
  "countryOfOrigin",
  "period",
  "materials",
  "description",
  "productStory",
  "condition",
  "conditionDescription",
] as const;
export type CanonicalProductDetailFieldKey = (typeof CANONICAL_PRODUCT_DETAIL_FIELD_KEYS)[number];

export const CANONICAL_PHYSICAL_FIELD_KEYS = ["lengthValue", "widthValue", "heightValue", "dimensionUnit", "weightValue", "weightUnit"] as const;
export type CanonicalPhysicalFieldKey = (typeof CANONICAL_PHYSICAL_FIELD_KEYS)[number];

export const CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS = [...CANONICAL_PRODUCT_DETAIL_FIELD_KEYS, ...CANONICAL_PHYSICAL_FIELD_KEYS] as const;
export type CanonicalProductProposalFieldKey = (typeof CANONICAL_PRODUCT_PROPOSAL_FIELD_KEYS)[number];

/**
 * Sprint 148: the isolated, non-channel-scoped canonical Product AI proposal - one row per
 * productId (never per channel; see Architecture Review Option B). Deliberately a separate
 * table/type from MarketplacePreparation above - never overloads PublishChannel, never reuses
 * marketplace_preparations. Generate never mutates Product/Marketing Tags; Accept is the only
 * mutation action, and only for the fields the admin explicitly selects (see
 * use-cases/canonical-product-proposal/useCases.ts). baseProductUpdatedAt is the Product-version
 * staleness baseline (mirrors MarketplacePreparation's own field exactly); this record's own
 * `updatedAt` (via Timestamps) is the proposal-freshness token Accept must be given back
 * (expectedProposalUpdatedAt), exactly mirroring approveMarketplacePreparation's
 * expectedProposalUpdatedAt contract. No confidence/evidence/provenance field exists here by
 * design (Architecture Review Decision: unsupported physical fields are simply omitted from the
 * proposal, never persisted with a confidence/estimate marker).
 */
export interface CanonicalProductProposal extends Timestamps {
  id: ID;
  productId: ID;
  status: CanonicalProductProposalStatus;
  baseProductUpdatedAt: string;
  // Product Details
  suggestedBrand?: string;
  suggestedModel?: string;
  suggestedManufacturer?: string;
  suggestedCountryOfOrigin?: string;
  suggestedPeriod?: string;
  suggestedMaterials?: string;
  suggestedDescription?: string;
  suggestedProductStory?: string;
  suggestedCondition?: string;
  suggestedConditionDescription?: string;
  // Physical Information - present only when explicit visible measurement evidence supported it.
  suggestedLengthValue?: number;
  suggestedWidthValue?: number;
  suggestedHeightValue?: number;
  suggestedDimensionUnit?: string;
  suggestedWeightValue?: number;
  suggestedWeightUnit?: string;
  // Marketing Tags - reviewable suggestions only; Accept is additive-only (see services/marketingTags.ts).
  suggestedMarketingTags?: string[];
  providerName: string;
  promptVersion: string;
  generatedAt: string;
  appliedAt?: string;
  appliedByAdminUserId?: string;
}

export interface MarketplaceWebhookEvent extends Timestamps { id: ID; channel: PublishChannel; externalEventId: string; eventType: string; status: string; signatureValid: boolean; payloadSnapshot: unknown; attemptCount: number; lastError?: string; receivedAt: string; processedAt?: string; }
export interface MarketplaceOrder extends Timestamps { id: ID; channel: PublishChannel; externalOrderId: string; externalOrderNumber?: string; marketplaceConnectionId: ID; internalOrderId?: ID; status: string; currency: string; subtotal: number; shipping: number; tax: number; total: number; buyerEmail?: string; buyerName?: string; shippingAddressSnapshot?: unknown; billingAddressSnapshot?: unknown; rawPayloadSnapshot: unknown; orderedAt: string; importedAt: string; }
export interface MarketplaceOrderItem { id: ID; marketplaceOrderId: ID; externalOrderItemId?: string; externalListingId?: string; productId?: ID; sku?: string; titleSnapshot: string; quantity: number; unitPrice: number; lineTotal: number; createdAt: string; }
export interface MarketplaceSyncResult { status: string; processedCount: number; successCount: number; failureCount: number; errors?: Array<{ type: string; message: string }>; }

import { ReturnStatus, ReturnReason, ReturnResolution, ReturnItemCondition, ReturnStockDisposition, RefundStatus, RefundType, MarketplaceReturnStatus, ReturnError } from "../enums/returns";

export interface ReturnRequest extends Timestamps { id: ID; orderId: ID; marketplaceOrderId?: ID; shipmentId?: ID; channel?: string; externalReturnId?: string; externalReturnNumber?: string; status: ReturnStatus | string; reason: ReturnReason | string; reasonDetails?: string; requestedResolution: ReturnResolution | string; approvedResolution?: ReturnResolution | string; buyerMessage?: string; internalNote?: string; requestedAt: string; authorizedAt?: string; receivedAt?: string; inspectedAt?: string; completedAt?: string; cancelledAt?: string; lastError?: string; returnCarrierCode?: string; returnTrackingNumber?: string; returnTrackingUrl?: string; buyerShippedAt?: string; }
export interface ReturnItem extends Timestamps { id: ID; returnRequestId: ID; orderItemId: ID; productId?: ID; quantityRequested: number; quantityApproved?: number; quantityReceived?: number; condition?: ReturnItemCondition | string; stockDisposition?: ReturnStockDisposition | string; inspectionNote?: string; }
export interface ReturnEvent { id: ID; returnRequestId: ID; eventType: string; previousStatus?: string; newStatus?: string; payloadSnapshot?: string; errorCode?: ReturnError | string; errorMessage?: string; createdAt: string; }
export interface Refund extends Timestamps { id: ID; orderId: ID; returnRequestId?: ID; channel?: string; externalRefundId?: string; type: RefundType | string; status: RefundStatus | string; currency: PriceCurrency | string; subtotalAmount: number; shippingAmount: number; taxAmount: number; marketplaceFeeAdjustment?: number; paymentFeeAdjustment?: number; totalAmount: number; reason?: string; idempotencyKey: string; submittedAt?: string; succeededAt?: string; failedAt?: string; lastError?: string; }
export interface RefundAllocation { id: ID; refundId: ID; orderItemId?: ID; returnItemId?: ID; quantity?: number; amount: number; createdAt: string; }
export interface ReturnReadiness { ready: boolean; reasons: string[]; allowedActions: string[]; }
export interface ReturnResult { returnRequest: ReturnRequest; items?: ReturnItem[]; events?: ReturnEvent[]; }
export interface RefundResult { refund: Refund; allocations?: RefundAllocation[]; }
export interface SaleReversalResult { id: ID; orderId: ID; returnRequestId?: ID; refundId?: ID; reversalType: string; stockReversed: boolean; financialsReversed: boolean; originalSaleFinancialId?: ID; sourceSnapshot: string; idempotencyKey: string; createdAt: string; }
export interface ReturnFinancialSummary { orderId: ID; originalGrossRevenue: number; refundedSubtotal: number; refundedShipping: number; refundedTax: number; marketplaceFeeAdjustment?: number; paymentFeeAdjustment?: number; totalRefunded: number; netRetainedRevenue: number; returnedItemCost?: number; stockDispositionWriteOffValue?: number; adjustedProfit?: number; adjustedProfitComplete: boolean; }
export interface MarketplaceReturnResult { status: MarketplaceReturnStatus | string; externalReturnId?: string; externalRefundId?: string; raw?: unknown; }

export * from "./erpIntegration";
