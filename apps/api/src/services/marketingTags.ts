import type { MarketingTag } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { createDrizzleMarketingTagRepository } from "../repositories/marketing-tags/drizzle";
import type { MarketingTagRecord, MarketingTagRepository } from "../repositories/marketing-tags/types";
import { getProductById } from "./products";
import { BadRequestError, NotFoundError } from "./errors";

const COMBINING_DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");
const APOSTROPHE_PATTERN = new RegExp("['\\u2019]", "g");

/**
 * Sprint 140: Marketing-Tag-specific canonicalization - deliberately NOT the shared
 * validation/common.ts slugify(), which hyphenates apostrophes rather than stripping them
 * (slugify("Father's Day") === "father-s-day", not the required "fathers-day"). Modifying the
 * shared slugify() was explicitly rejected at Architecture Review since Category/Collection/
 * Product slugs already depend on its current apostrophe-as-separator behavior.
 *
 * lowercase -> trim -> NFKD -> strip combining diacritics -> strip apostrophes entirely ->
 * collapse every remaining non-[a-z0-9] run to one "-" -> trim leading/trailing "-". Returns null
 * for a canonical key that would be empty (never a fabricated/empty key).
 */
export function canonicalizeMarketingTagKey(input: string): string | null {
  const key = input
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS_PATTERN, "")
    .replace(APOSTROPHE_PATTERN, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key.length > 0 ? key : null;
}

function toMarketingTag(row: MarketingTagRecord): MarketingTag {
  return { id: row.id, key: row.key, label: row.label, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function repository(db: DbClient): MarketingTagRepository {
  return createDrizzleMarketingTagRepository(db);
}

export async function listProductMarketingTags(db: DbClient, productId: string): Promise<MarketingTag[]> {
  await getProductById(db, productId); // throws NotFoundError if missing
  const rows = await repository(db).listByProduct(productId);
  return rows.map(toMarketingTag);
}

/**
 * Sprint 140: Admin-triggered add - canonicalizes the submitted label server-side (the Admin
 * never supplies a machine key directly), find-or-creates the canonical marketing_tags row, then
 * adds the Product relation idempotently. Rejects a label whose canonical key would be empty.
 */
export async function addProductMarketingTag(db: DbClient, productId: string, label: string): Promise<MarketingTag> {
  await getProductById(db, productId); // throws NotFoundError if missing
  const trimmedLabel = label.trim();
  const key = canonicalizeMarketingTagKey(trimmedLabel);
  if (!key || !trimmedLabel) throw new BadRequestError("Marketing Tag label must produce a non-empty canonical key");

  const repo = repository(db);
  const tag = await repo.findOrCreateByKey(key, trimmedLabel);
  await repo.addRelation(productId, tag.id);
  return toMarketingTag(tag);
}

/** Removes only the one Product/tag relation - the global marketing_tags row is always preserved. */
export async function removeProductMarketingTag(db: DbClient, productId: string, marketingTagId: string): Promise<void> {
  await getProductById(db, productId); // throws NotFoundError if missing
  const removed = await repository(db).removeRelation(productId, marketingTagId);
  if (!removed) throw new NotFoundError("Marketing Tag relation not found for this Product");
}

/**
 * Sprint 140: the automatic AI initial-population write - called only from the AI Sales
 * Preparation Outbox handler, never from an Admin-facing route. Locked ownership rule: writes
 * ONLY when the Product currently has zero Marketing Tag relations; once any tag exists (AI- or
 * Admin-origin, no distinction), this is permanently a no-op for that Product - Admin owns the
 * set. Canonicalizes and deduplicates suggestions before any write; an empty/unusable suggestion
 * list writes nothing (never fails the caller) - Marketing Tag enrichment is best-effort.
 */
export async function applyAiSuggestedMarketingTagsIfProductHasNone(db: DbClient, productId: string, suggestedLabels: string[]): Promise<void> {
  const repo = repository(db);
  if (await repo.hasAnyForProduct(productId)) return; // Admin (or an earlier successful run) already owns the set - never touch it.

  const canonical = new Map<string, string>(); // key -> first-seen label
  for (const raw of suggestedLabels) {
    if (typeof raw !== "string") continue;
    const trimmedLabel = raw.trim();
    const key = canonicalizeMarketingTagKey(trimmedLabel);
    if (!key || !trimmedLabel || canonical.has(key)) continue;
    canonical.set(key, trimmedLabel);
  }
  if (canonical.size === 0) return; // No usable suggestions - leave Marketing Tags empty, Admin can add manually.

  for (const [key, label] of canonical) {
    const tag = await repo.findOrCreateByKey(key, label);
    await repo.addRelation(productId, tag.id);
  }
}
