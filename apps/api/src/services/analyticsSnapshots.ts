import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import { createSqliteAnalyticsSnapshotRepository } from "../repositories/analytics/analyticsSnapshotsSqlite";
import { catalogueProfitabilityQuerySchema } from "../use-cases/analytics/catalogueProfitability";
import { buildProfitabilitySnapshotMetrics, observationDay, PROFITABILITY_SNAPSHOT_SOURCE, type ProductMetricHistoryQuery } from "../use-cases/analytics/profitabilitySnapshots";
import { getCatalogueProfitability, getProductProfitability } from "./productProfitability";

/**
 * Analytics Phase 1G: daily, idempotent internal profitability snapshot. Evaluates the unchanged
 * Phase 1B-1E catalogue as of the observation day (UTC midnight), maps it to metrics (pure use
 * case) and stores them with provenance. A retry for the same day replays the completed run
 * instead of duplicating rows. Writes only analytics_runs / analytics_metric_snapshots.
 */
export function runProfitabilitySnapshot(db: DbClient, options: { now?: Date; collectedAt?: Date } = {}) {
  const collectedAt = options.collectedAt ?? new Date();
  const observed = observationDay(options.now ?? collectedAt);
  const observedAt = observed.toISOString();
  const { runType, sourceType, sourceReference } = PROFITABILITY_SNAPSHOT_SOURCE;
  const repo = createSqliteAnalyticsSnapshotRepository(db);
  const idempotencyKey = `${runType}:${sourceReference}:${observedAt}`;

  const existing = repo.findRun(idempotencyKey);
  if (existing?.status === "completed") return { run: existing, replayed: true };

  const run = { id: randomUUID(), runType, sourceType, sourceReference, idempotencyKey, observedAt, startedAt: collectedAt.toISOString() };
  try {
    const catalogue = getCatalogueProfitability(db, { ...catalogueProfitabilityQuerySchema.parse({}), limit: Number.MAX_SAFE_INTEGER }, observed);
    const metrics = buildProfitabilitySnapshotMetrics(catalogue);
    return { run: repo.writeCompletedRun(run, new Date().toISOString(), collectedAt.toISOString(), metrics), replayed: false };
  } catch (error) {
    const concurrent = repo.findRun(idempotencyKey);
    if (concurrent?.status === "completed") return { run: concurrent, replayed: true };
    repo.recordFailedRun(run, error instanceof Error ? error.message.slice(0, 500) : "analytics snapshot failed");
    throw error;
  }
}

/** Read-only: one product's stored metric history (product existence verified via Phase 1B). */
export function getProductAnalyticsHistory(db: DbClient, productId: string, query: ProductMetricHistoryQuery) {
  getProductProfitability(db, productId);
  const items = createSqliteAnalyticsSnapshotRepository(db).listProductHistory(productId, query);
  return { productId, items, meta: { returned: items.length, limit: query.limit, filters: { metricKey: query.metricKey ?? null, from: query.from ?? null, to: query.to ?? null } } };
}
