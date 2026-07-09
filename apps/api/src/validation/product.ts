import {
  DIMENSION_UNIT_VALUES,
  PRICE_CURRENCY_VALUES,
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  ProductType,
  WEIGHT_UNIT_VALUES,
} from "@noctella/shared";
import { z } from "zod";

const imageSchema = z.object({
  url: z.string().min(1, "Image URL is required"),
  altText: z.string().optional(),
  sortOrder: z.number().int().min(0).default(0),
  isPrimary: z.boolean().default(false),
});

/**
 * Base field set shared by create/update. Business rules that depend on
 * *type* (Unique Item vs Lot Item) are enforced separately in
 * services/products.ts, since they interact with defaults that zod alone
 * can't express cleanly.
 */
const baseProductSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
  title: z.string().min(1, "Title is required"),
  slug: z.string().min(1).optional(),
  type: z.enum(PRODUCT_TYPE_VALUES as [ProductType, ...ProductType[]]),
  status: z.enum(PRODUCT_STATUS_VALUES as [string, ...string[]]),
  categoryId: z.string().min(1, "Category is required"),
  collectionId: z.string().min(1).optional(),

  brand: z.string().optional(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  period: z.string().optional(),
  materials: z.string().optional(),
  description: z.string().optional(),
  productStory: z.string().optional(),
  condition: z.string().optional(),
  conditionDescription: z.string().optional(),

  lengthValue: z.number().min(0, "Length must be non-negative").optional(),
  widthValue: z.number().min(0, "Width must be non-negative").optional(),
  heightValue: z.number().min(0, "Height must be non-negative").optional(),
  dimensionUnit: z.enum(DIMENSION_UNIT_VALUES as [string, ...string[]]).optional(),
  weightValue: z.number().min(0, "Weight must be non-negative").optional(),
  weightUnit: z.enum(WEIGHT_UNIT_VALUES as [string, ...string[]]).optional(),

  stockQuantity: z.number().int().min(0, "Stock quantity cannot be negative").optional(),
  lotItemCount: z.number().int().min(1).optional(),
  purchaseCost: z.number().min(0, "Purchase cost cannot be negative").optional(),
  purchaseCurrency: z.enum(PRICE_CURRENCY_VALUES as [string, ...string[]]).optional(),
  internalNotes: z.string().optional(),

  priceEur: z.number().positive("EUR price must be greater than 0"),
  priceUsd: z.number().positive("USD price must be greater than 0").optional(),
  minOfferPrice: z.number().min(0, "Minimum offer price cannot be negative").optional(),

  videoUrl: z.string().optional(),

  shippingProfile: z.string().optional(),
  shippingNote: z.string().optional(),
  customsWarning: z.boolean().default(false),

  seoTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),

  isFeatured: z.boolean().default(false),
  allowMakeOffer: z.boolean().default(false),
  allowCashOnDelivery: z.boolean().default(false),
  showInArchiveAfterSale: z.boolean().default(false),

  images: z.array(imageSchema).optional(),
});

export const createProductSchema = baseProductSchema.superRefine((data, ctx) => {
  const primaryCount = (data.images ?? []).filter((img) => img.isPrimary).length;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["images"],
      message: "Only one primary image is allowed",
    });
  }
  if (data.type === ProductType.UniqueItem && (data.stockQuantity ?? 1) > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["stockQuantity"],
      message: "Unique Item stock quantity cannot exceed 1",
    });
  }
});

export const updateProductSchema = baseProductSchema.partial().superRefine((data, ctx) => {
  const primaryCount = (data.images ?? []).filter((img) => img.isPrimary).length;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["images"],
      message: "Only one primary image is allowed",
    });
  }
  if (data.type === ProductType.UniqueItem && data.stockQuantity !== undefined && data.stockQuantity > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["stockQuantity"],
      message: "Unique Item stock quantity cannot exceed 1",
    });
  }
});

export const productListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(PRODUCT_STATUS_VALUES as [string, ...string[]]).optional(),
  type: z.enum(PRODUCT_TYPE_VALUES as [ProductType, ...ProductType[]]).optional(),
  categoryId: z.string().optional(),
  collectionId: z.string().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
