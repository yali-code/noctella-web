import type { DbClient } from "../db/client";
import { getProductById } from "./products";
import { buildSalesEnrichmentContext } from "../sales-enrichment/context";
import { createSalesEnrichmentProvider } from "../sales-enrichment/providerFactory";
import { DeterministicSalesEnrichmentPromptBuilder } from "../sales-enrichment/promptBuilder";
import type { SalesEnrichmentProvider, SalesEnrichmentResult } from "../sales-enrichment/types";

/**
 * Sprint 140: the single Product-level AI Sales Enrichment call - reads the canonical Product
 * fresh (getProductById, never staged AI Intake data), builds context, calls the provider.
 * Returns only the transient suggestion result; persistence (canonicalize/dedupe/empty-set-check/
 * write) is entirely services/marketingTags.ts's responsibility, called separately by the AI
 * Sales Preparation Outbox handler - this function never writes anything itself.
 */
export async function generateSalesEnrichment(
  db: DbClient,
  productId: string,
  provider: SalesEnrichmentProvider = createSalesEnrichmentProvider(),
): Promise<SalesEnrichmentResult> {
  const product = await getProductById(db, productId); // throws NotFoundError if missing
  const context = buildSalesEnrichmentContext(product);
  const prompt = new DeterministicSalesEnrichmentPromptBuilder().build(context);
  const { result } = await provider.generate({ context, prompt });
  return result;
}
