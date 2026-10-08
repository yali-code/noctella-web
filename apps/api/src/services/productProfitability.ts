import type { DbClient } from "../db/client";
import { createSqliteProductProfitabilityReadRepository } from "../repositories/analytics/productProfitabilitySqlite";
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
