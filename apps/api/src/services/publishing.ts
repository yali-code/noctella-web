import {
  ListingStatus,
  PriceCurrency,
  ProductStatus,
  PublishChannel,
  type PublishPayload,
  type PublishPreview,
  type PublishPreviewPhoto,
  type PublishReadinessSummary,
  type PublishValidation,
  type PublishValidationIssue,
} from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories } from "../db/schema";
import { eq } from "drizzle-orm";
import { BadRequestError } from "./errors";
import { getProductById, type ProductWithImages } from "./products";

export const SUPPORTED_PUBLISH_CHANNELS = [PublishChannel.Ebay, PublishChannel.Etsy, PublishChannel.NoctellaWeb] as const;

type IssueTarget = "errors" | "warnings";

function issue(code: string, message: string, field?: string): PublishValidationIssue {
  return { code, message, field };
}

function add(result: PublishValidation, target: IssueTarget, code: string, message: string, field?: string): void {
  result[target].push(issue(code, message, field));
}

function orderedPhotos(product: ProductWithImages): PublishPreviewPhoto[] {
  const photos = product.photos.length > 0 ? product.photos : product.images;
  return [...photos]
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    })
    .map((photo) => ({
      id: photo.id,
      url: photo.url,
      thumbnailUrl: "thumbnailUrl" in photo && typeof photo.thumbnailUrl === "string" ? photo.thumbnailUrl : undefined,
      altText: photo.altText,
      sortOrder: photo.sortOrder,
      isPrimary: photo.isPrimary,
    }));
}

async function categoryLabel(db: DbClient, product: ProductWithImages, channel: PublishChannel): Promise<string | undefined> {
  if (channel === PublishChannel.Ebay) return product.ebayCategory;
  if (product.categoryId) {
    const [row] = await db.select({ name: categories.name }).from(categories).where(eq(categories.id, product.categoryId));
    return row?.name ?? product.categoryId;
  }
  return undefined;
}

function baseValidation(channel: PublishChannel, product: ProductWithImages): PublishValidation {
  const result: PublishValidation = { channel, productId: product.id, isReady: false, errors: [], warnings: [] };
  if (!product.title) add(result, "errors", "missing_title", "Title is required", "title");
  if (!product.description) add(result, "errors", "missing_description", "Description is required", "description");
  if (product.priceEur <= 0) add(result, "errors", "invalid_price", "Price must be greater than zero", "priceEur");
  if (!product.categoryId) add(result, "errors", "missing_category", "Category is required", "categoryId");
  if (!product.sku) add(result, "errors", "missing_sku", "SKU is required", "sku");
  if (!product.condition) add(result, "errors", "missing_condition", "Condition is required", "condition");
  if (orderedPhotos(product).length === 0) add(result, "errors", "missing_photo", "At least one product photo or legacy image is required", "photos");
  if (product.stockQuantity <= 0) add(result, "errors", "invalid_stock", "Stock quantity must be greater than zero", "stockQuantity");
  if ([ProductStatus.Sold, ProductStatus.Reserved, ProductStatus.Archived, ProductStatus.Returned].includes(product.status)) {
    add(result, "errors", "invalid_status", "Sold, reserved, archived, or returned products cannot be published", "status");
  }
  return result;
}

function validateEbay(product: ProductWithImages, result: PublishValidation): void {
  if (!product.ebayCategory) add(result, "errors", "missing_ebay_category", "eBay category or channel mapping is required", "ebayCategory");
  if (!product.condition) add(result, "errors", "missing_ebay_condition", "eBay condition is required", "condition");
  if (!product.shippingProfile && !product.shippingNote) add(result, "errors", "missing_ebay_shipping", "eBay shipping configuration is required", "shippingProfile");
  if (!product.ebaySubtitle) add(result, "warnings", "missing_ebay_subtitle", "eBay subtitle is recommended", "ebaySubtitle");
}

function validateEtsy(product: ProductWithImages, result: PublishValidation): void {
  if (!product.categoryId) add(result, "errors", "missing_etsy_taxonomy", "Etsy taxonomy/category mapping is required", "categoryId");
  if (!product.description && !product.etsyDescription) add(result, "errors", "missing_etsy_description", "Etsy description is required", "description");
  if (!product.shippingProfile && !product.shippingNote) add(result, "errors", "missing_etsy_shipping", "Etsy shipping configuration is required", "shippingProfile");
  if (!product.etsyTags || product.etsyTags.length < 3) add(result, "warnings", "insufficient_etsy_tags", "Add at least three Etsy tags", "etsyTags");
}

function validateNoctellaWeb(product: ProductWithImages, result: PublishValidation): void {
  if (!product.categoryId) add(result, "errors", "missing_storefront_category", "Storefront category is required", "categoryId");
  if (orderedPhotos(product).length === 0) add(result, "errors", "missing_storefront_photo", "Primary or first sorted photo is required", "photos");
  if (product.priceEur <= 0) add(result, "errors", "missing_storefront_price", "Published-ready price is required", "priceEur");
}

export async function validateProductForPublish(db: DbClient, productId: string, channel: PublishChannel): Promise<PublishValidation> {
  const product = await getProductById(db, productId);
  const result = baseValidation(channel, product);
  if (channel === PublishChannel.Ebay) validateEbay(product, result);
  if (channel === PublishChannel.Etsy) validateEtsy(product, result);
  if (channel === PublishChannel.NoctellaWeb) validateNoctellaWeb(product, result);
  result.isReady = result.errors.length === 0;
  return result;
}

export async function buildPublishPreview(db: DbClient, productId: string, channel: PublishChannel): Promise<PublishPreview> {
  const product = await getProductById(db, productId);
  const validation = await validateProductForPublish(db, productId, channel);
  if (validation.errors.length > 0) throw new BadRequestError("Product is not ready to publish");
  return {
    channel,
    productId,
    title: channel === PublishChannel.Ebay ? product.ebayTitle ?? product.title : channel === PublishChannel.Etsy ? product.etsyTitle ?? product.title : product.title,
    subtitle: channel === PublishChannel.Ebay ? product.ebaySubtitle : undefined,
    description: channel === PublishChannel.Etsy ? product.etsyDescription ?? product.description : channel === PublishChannel.Ebay ? product.ebayDescription ?? product.description : product.description,
    price: channel === PublishChannel.Ebay ? product.ebayListingPriceEur ?? product.priceEur : channel === PublishChannel.Etsy ? product.etsyListingPriceEur ?? product.priceEur : product.priceEur,
    currency: PriceCurrency.Eur,
    category: await categoryLabel(db, product, channel),
    condition: product.condition,
    sku: product.sku,
    stock: product.stockQuantity,
    photos: orderedPhotos(product),
    shippingSummary: product.shippingProfile ?? product.shippingNote,
    validation,
  };
}

export function buildEbayPayload(preview: PublishPreview): PublishPayload {
  return { ...preview, status: ListingStatus.Ready, data: { title: preview.title, category: preview.category, price: preview.price, photos: preview.photos } };
}

export function buildEtsyPayload(preview: PublishPreview): PublishPayload {
  return { ...preview, status: ListingStatus.Ready, data: { title: preview.title, taxonomy: preview.category, price: preview.price, photos: preview.photos } };
}

export function buildNoctellaWebPayload(preview: PublishPreview): PublishPayload {
  return { ...preview, status: ListingStatus.Ready, data: { title: preview.title, slugSource: preview.title, price: preview.price, photos: preview.photos } };
}

export async function buildPublishPayload(db: DbClient, productId: string, channel: PublishChannel): Promise<PublishPayload> {
  const preview = await buildPublishPreview(db, productId, channel);
  if (channel === PublishChannel.Ebay) return buildEbayPayload(preview);
  if (channel === PublishChannel.Etsy) return buildEtsyPayload(preview);
  return buildNoctellaWebPayload(preview);
}

export async function getPublishReadinessSummary(db: DbClient, productId: string): Promise<PublishReadinessSummary> {
  const channels = await Promise.all(SUPPORTED_PUBLISH_CHANNELS.map((channel) => validateProductForPublish(db, productId, channel)));
  return { productId, channels };
}
