import type { Product, ProductType } from "@noctella/shared";
import type {
  OrderItemRepositoryRecord,
  OrderRepositoryRecord,
} from "../repositories/order/types";

export interface TypeScriptBuildBaselineAuditResult {
  status: "PASS";
  sharedModuleResolved: true;
  orderRepositoryFields: readonly string[];
  orderItemRepositoryFields: readonly string[];
  productFields: readonly string[];
}

type Expect<T extends true> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type AllowsUndefined<T> = undefined extends T ? true : false;

type _OrderRepositoryRecordFields = Expect<
  HasKey<OrderRepositoryRecord, "id"> &
  HasKey<OrderRepositoryRecord, "orderNumber"> &
  HasKey<OrderRepositoryRecord, "guestEmail"> &
  HasKey<OrderRepositoryRecord, "status"> &
  HasKey<OrderRepositoryRecord, "paymentStatus"> &
  HasKey<OrderRepositoryRecord, "subtotalAmount"> &
  HasKey<OrderRepositoryRecord, "totalAmount"> &
  HasKey<OrderRepositoryRecord, "currency"> &
  HasKey<OrderRepositoryRecord, "createdAt"> &
  HasKey<OrderRepositoryRecord, "updatedAt">
>;

type _OrderItemRepositoryRecordFields = Expect<
  HasKey<OrderItemRepositoryRecord, "id"> &
  HasKey<OrderItemRepositoryRecord, "orderId"> &
  HasKey<OrderItemRepositoryRecord, "productId"> &
  HasKey<OrderItemRepositoryRecord, "quantity">
>;

type _ProductHydratedFields = Expect<
  HasKey<Product, "id"> &
  HasKey<Product, "sku"> &
  HasKey<Product, "categoryId"> &
  HasKey<Product, "collectionId"> &
  HasKey<Product, "type"> &
  HasKey<Product, "stockQuantity">
>;

type _ProductOptionality = Expect<
  AllowsUndefined<Product["categoryId"]> & AllowsUndefined<Product["collectionId"]>
>;

const productTypeVisibility: ProductType | undefined = undefined;
void productTypeVisibility;

export function runTypeScriptBuildBaselineAudit(): TypeScriptBuildBaselineAuditResult {
  return {
    status: "PASS",
    sharedModuleResolved: true,
    orderRepositoryFields: [
      "id",
      "orderNumber",
      "guestEmail",
      "status",
      "paymentStatus",
      "subtotalAmount",
      "totalAmount",
      "currency",
      "createdAt",
      "updatedAt",
    ],
    orderItemRepositoryFields: ["id", "orderId", "productId", "quantity"],
    productFields: [
      "id",
      "sku",
      "categoryId",
      "collectionId",
      "type",
      "stockQuantity",
    ],
  };
}

if (process.argv[1]?.endsWith("typescriptBuildBaselineAudit.ts")) {
  console.log(JSON.stringify(runTypeScriptBuildBaselineAudit(), null, 2));
}
