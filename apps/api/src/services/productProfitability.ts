import type { DbClient } from "../db/client";
import { createSqliteProductProfitabilityReadRepository } from "../repositories/analytics/productProfitabilitySqlite";
import { buildCatalogueProfitability, type CatalogueProfitabilityQuery, type CatalogueProfitabilityResult } from "../use-cases/analytics/catalogueProfitability";
import { DEFAULT_ANALYTICS_THRESHOLDS, deriveProfitabilityInsights, type AnalyticsInsight, type AnalyticsThresholds } from "../use-cases/analytics/profitabilityInsights";
import { projectProductProfitability, PROVISIONAL_PROFITABILITY_POLICY, type ProductProfitability, type ProfitabilityPolicy } from "../use-cases/analytics/productProfitability";
import { NotFoundError } from "./errors";

/**
 * Analytics Phase 1B: internal, read-only service - resolves the canonical source rows through
 * the read repository, then delegates every calculation to the pure, deterministic projection
 * (Service -> UseCase -> Repository, mirroring services/readiness.ts). SQLite only (production
 * source of truth); no route is exposed yet and nothing is persisted.
 */
export function getProductProfitability(
  db: DbClient,
  productId: string,
  now: Date = new Date(),
  policy: ProfitabilityPolicy = PROVISIONAL_PROFITABILITY_POLICY,
): ProductProfitability {
  const source = createSqliteProductProfitabilityReadRepository(db).loadSource(productId);
  if (!source) throw new NotFoundError("Product not found");
  return projectProductProfitability(source, now, policy);
}

/**
 * Analytics Phase 1C: read-only, advisory insights for one product - the Phase 1B profitability
 * projection is the sole input; the pure use case derives insights from it. No writes, no
 * persistence, no delivery.
 */
export function getProductProfitabilityInsights(db: DbClient, productId: string, now: Date = new Date(), thresholds: AnalyticsThresholds = DEFAULT_ANALYTICS_THRESHOLDS): AnalyticsInsight[] {
  return deriveProfitabilityInsights(getProductProfitability(db, productId, now), now, thresholds);
}

/**
 * Analytics Phase 1D: read-only catalogue evaluation - one batch load (bounded query per table),
 * then the unchanged Phase 1B projection and Phase 1C insight derivation per product, then pure
 * aggregation/filtering/sorting. No writes, no caching, no persistence.
 */
export function getCatalogueProfitability(
  db: DbClient,
  query: CatalogueProfitabilityQuery,
  now: Date = new Date(),
  policy: ProfitabilityPolicy = PROVISIONAL_PROFITABILITY_POLICY,
  thresholds: AnalyticsThresholds = DEFAULT_ANALYTICS_THRESHOLDS,
): CatalogueProfitabilityResult {
  const evaluated = createSqliteProductProfitabilityReadRepository(db)
    .loadSources()
    .map((source) => {
      const profitability = projectProductProfitability(source, now, policy);
      return { profitability, insights: deriveProfitabilityInsights(profitability, now, thresholds) };
    });
  return buildCatalogueProfitability(evaluated, query, now, policy, thresholds);
}
