import { AdminRole } from "../enums/adminRole";
import { ProductStatus } from "../enums/productStatus";
import { ProductType } from "../enums/productType";
import { DimensionUnit } from "../enums/dimensionUnit";
import { WeightUnit } from "../enums/weightUnit";
import { PriceCurrency } from "../enums/priceCurrency";

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
}

export interface Order extends Timestamps {
  id: ID;
  customerId?: ID;
  guestEmail?: string;
  status: string;
  totalAmount: number;
  currencyId: ID;
}

export interface OrderItem extends Timestamps {
  id: ID;
  orderId: ID;
  productId: ID;
  quantity: number;
  unitPrice: number;
}

/** Draft produced by the AI listing step, before admin review/publish. */
export interface AiListingDraft extends Timestamps {
  id: ID;
  erpReferenceId?: ID;
  suggestedTitle?: string;
  suggestedDescription?: string;
  suggestedPrice?: number;
  status: ProductStatus;
  reviewedByAdminUserId?: ID;
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
