import { AdminRole } from "../enums/adminRole";
import { ProductStatus } from "../enums/productStatus";
import { ProductType } from "../enums/productType";
import { DimensionUnit } from "../enums/dimensionUnit";
import { WeightUnit } from "../enums/weightUnit";
import { PriceCurrency } from "../enums/priceCurrency";
import { ListingStatus } from "../enums/listingStatus";
import { PublishChannel } from "../enums/publishChannel";
import { AiDraftStatus } from "../enums/aiDraftStatus";
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
  priceEur: number;
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
  paymentReference?: string;
  billingAddress: Address;
  shippingAddress: Address;
  notes?: string;
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

  rejectionReason?: string;
  reviewedByAdminUserId?: ID;
  reviewedAt?: string;
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
  | "content_warning";

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
