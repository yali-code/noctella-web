import { z } from "zod";
import type { CanonicalProductPhotoReader, CanonicalProductPhotoReference } from "../canonical-product-ai/types";

/** One AI call fills every AI-owned Product field. Condition, stock, cost, notes and measurements are never included. */
const TEXT_FIELDS = [
  "brand", "model", "manufacturer", "countryOfOrigin", "period", "materials", "description", "productStory", "conditionDescription",
  "seoTitle", "metaDescription",
  "ebayTitle", "ebayDescription", "ebayConditionDescription", "ebayItemSpecifics",
  "etsyTitle", "etsyDescription", "etsyMaterials", "etsyStyle", "etsyOccasion",
  "wooProductName", "wooLongDescription", "wooShortDescription", "wooSeoTitle", "wooMetaDescription", "wooFocusKeyword",
] as const;
const NUMBER_FIELDS = ["priceEur", "priceUsd", "minOfferPrice"] as const;
const LIST_FIELDS = ["keywords", "etsyTags", "marketingTags"] as const;

export type ProductAiFillTextField = (typeof TEXT_FIELDS)[number];
export type ProductAiFillNumberField = (typeof NUMBER_FIELDS)[number];
export type ProductAiFillListField = (typeof LIST_FIELDS)[number];
export type ProductAiFillResult = Record<ProductAiFillTextField, string> & Record<ProductAiFillNumberField, number> & Record<ProductAiFillListField, string[]>;

export const PRODUCT_AI_FILL_TEXT_FIELDS = TEXT_FIELDS;
export const PRODUCT_AI_FILL_NUMBER_FIELDS = NUMBER_FIELDS;

export function buildProductAiFillJsonSchema() {
  const properties: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) properties[field] = { type: "string" };
  for (const field of NUMBER_FIELDS) properties[field] = { type: "number" };
  for (const field of LIST_FIELDS) properties[field] = { type: "array", items: { type: "string" } };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false } as const;
}

export function buildProductAiFillZodSchema() {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of TEXT_FIELDS) shape[field] = z.string();
  for (const field of NUMBER_FIELDS) shape[field] = z.number();
  for (const field of LIST_FIELDS) shape[field] = z.array(z.string());
  return z.object(shape).strict();
}

export interface ProductAiFillContext {
  title: string;
  categoryName?: string;
  condition?: string;
  conditionDescription?: string;
  known: Record<string, string>;
  purchaseCostEur?: number;
  photos: CanonicalProductPhotoReference[];
}

export const PRODUCT_AI_FILL_PROMPT_VERSION = "product-ai-fill-v1";

export function buildProductAiFillPrompt(context: ProductAiFillContext) {
  const systemPrompt =
    "You fill a draft catalog and marketplace listing for a vintage and antique collectibles dealer. A human reviews everything before publishing. " +
    "Fill every field. Never answer unknown, N/A or an empty value: when unsure, write your single most likely estimate from the photos, title and your product knowledge. " +
    "The warehouse condition and warehouse condition note are authoritative: never contradict them. " +
    "Working state rule: state that an item works, is tested or functions only if the warehouse note says so. If the note does not say so, write that functionality was not tested. Do not call an item good or great condition unless the warehouse data says so. Describe visible wear from the photos as appearance only. " +
    "Prices are realistic estimates: priceEur is the asking price in EUR, priceUsd the same asking price in USD, minOfferPrice the lowest acceptable offer in EUR, at most priceEur. If a purchase cost is given, keep minOfferPrice above it where the market allows. " +
    "Limits: ebayTitle at most 80 characters, etsyTitle at most 140, etsyTags 13 tags of at most 20 characters each, seoTitle and wooSeoTitle at most 60, metaDescription and wooMetaDescription at most 160. " +
    "Write all text in English. marketingTags are short campaign or theme labels, keywords are search terms.";
  const lines = [
    `Product title: ${context.title}`,
    context.categoryName ? `Category: ${context.categoryName}` : undefined,
    `Warehouse condition: ${context.condition ?? "not declared"}`,
    `Warehouse condition note: ${context.conditionDescription ?? "none"}`,
    context.purchaseCostEur != null ? `Purchase cost: ${context.purchaseCostEur} EUR` : undefined,
    ...Object.entries(context.known).map(([key, value]) => `Existing ${key}: ${value}`),
    `Attached photos: ${context.photos.length}`,
  ].filter((line): line is string => Boolean(line));
  return { version: PRODUCT_AI_FILL_PROMPT_VERSION, systemPrompt, userPrompt: lines.join("\n") };
}

export interface ProductAiFillProvider {
  fill(request: { context: ProductAiFillContext; photoReader: CanonicalProductPhotoReader }): Promise<ProductAiFillResult>;
}
