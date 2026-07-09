import { AdminRole } from "../enums/adminRole";
import { ProductStatus } from "../enums/productStatus";
import { ProductType } from "../enums/productType";

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
  parentId?: ID;
}

export interface Collection extends Timestamps {
  id: ID;
  name: string;
  slug: string;
  description?: string;
}

export interface ProductImage extends Timestamps {
  id: ID;
  productId: ID;
  url: string;
  altText?: string;
  sortOrder: number;
}

export interface Product extends Timestamps {
  id: ID;
  erpReferenceId?: ID;
  sku: string;
  title: string;
  slug: string;
  description?: string;
  type: ProductType;
  status: ProductStatus;
  price: number;
  currencyId: ID;
  categoryId?: ID;
  collectionId?: ID;
  quantity: number;
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
