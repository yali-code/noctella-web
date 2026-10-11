import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";

/**
 * Analytics Phase 1G: SQLite persistence for analytics runs and metric snapshots - writes only to
 * analytics_runs / analytics_metric_snapshots, never to an operational table. better-sqlite3
 * transaction callbacks stay synchronous.
 */
export interface AnalyticsRunRecord {
  readonly id: string;
  readonly runType: string;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly observedAt: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly metricCount: number;
  readonly error: string | null;
}

export interface AnalyticsSnapshotRow {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly metricNamespace: string;
  readonly metricKey: string;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly valueState: string;
  readonly unit: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

export function createSqliteAnalyticsSnapshotRepository(db: any) {
  const findRun = (idempotencyKey: string): AnalyticsRunRecord | null =>
    db.select().from(schema.analyticsRuns).where(eq(schema.analyticsRuns.idempotencyKey, idempotencyKey)).get() ?? null;

  return Object.freeze({
    findRun,

    /** Stage 3A: the connected marketplace connection for a channel (existing "connected" convention), or null. */
    findConnectedConnection(channel: string, accountLabel?: string): { id: string; encryptedAccessToken: string } | null {
      const filters = [eq(schema.marketplaceConnections.channel, channel), eq(schema.marketplaceConnections.status, "connected")];
      if (accountLabel) filters.push(eq(schema.marketplaceConnections.accountLabel, accountLabel));
      const row = db.select({ id: schema.marketplaceConnections.id, encryptedAccessToken: schema.marketplaceConnections.encryptedAccessToken }).from(schema.marketplaceConnections).where(and(...filters)).get();
      return row?.encryptedAccessToken ? { id: row.id, encryptedAccessToken: row.encryptedAccessToken } : null;
    },

    /** Stage 3B: sanitized connection facts for readiness - booleans/metadata only, never token values. */
    findConnectionSummary(channel: string): { id: string; status: string; hasAccessToken: boolean; hasRefreshToken: boolean; tokenExpiresAt: string | null; scopes: string[] } | null {
      const row = db.select().from(schema.marketplaceConnections).where(eq(schema.marketplaceConnections.channel, channel)).get();
      if (!row) return null;
      let scopes: string[] = [];
      try { const parsed = JSON.parse(row.scopes ?? "[]"); if (Array.isArray(parsed)) scopes = parsed.map(String); } catch { scopes = []; }
      return { id: row.id, status: row.status, hasAccessToken: Boolean(row.encryptedAccessToken), hasRefreshToken: Boolean(row.encryptedRefreshToken), tokenExpiresAt: row.tokenExpiresAt ?? null, scopes };
    },

    /** Stage 3B: every external listing id Noctella holds for a channel (read-only). */
    listExternalListingIds(channel: string): string[] {
      return [...new Set((db.select({ id: schema.externalListings.externalListingId }).from(schema.externalListings).where(eq(schema.externalListings.channel, channel)).all() as any[]).map((r) => String(r.id)))].sort();
    },

    /**
     * Stage 3A: read-only listing -> product mapping from the existing external_listings table.
     * A listing id mapped to more than one product is ambiguous and is never mapped (no guessing).
     */
    mapExternalListings(channel: string, externalListingIds: readonly string[]): Map<string, string> {
      const ids = [...new Set(externalListingIds)];
      const products = new Map<string, Set<string>>();
      for (let i = 0; i < ids.length; i += 500) {
        for (const row of db.select({ externalListingId: schema.externalListings.externalListingId, productId: schema.externalListings.productId }).from(schema.externalListings).where(and(eq(schema.externalListings.channel, channel), inArray(schema.externalListings.externalListingId, ids.slice(i, i + 500)))).all() as any[]) {
          products.set(row.externalListingId, (products.get(row.externalListingId) ?? new Set()).add(row.productId));
        }
      }
      return new Map([...products].filter(([, set]) => set.size === 1).map(([id, set]) => [id, [...set][0]!]));
    },

    /**
     * Atomically records a completed run and its snapshots. Snapshot inserts are idempotent on the
     * identity index (scope, namespace, key, observedAt, source), so a retried run never duplicates
     * rows; a previously failed run row for the same key is completed in place.
     */
    writeCompletedRun(run: Omit<AnalyticsRunRecord, "status" | "completedAt" | "metricCount" | "error">, completedAt: string, collectedAt: string, rows: readonly AnalyticsSnapshotRow[]): AnalyticsRunRecord {
      db.transaction((tx: any) => {
        const existing = tx.select().from(schema.analyticsRuns).where(eq(schema.analyticsRuns.idempotencyKey, run.idempotencyKey)).get();
        const runId = existing?.id ?? run.id;
        for (const row of rows) {
          tx.insert(schema.analyticsMetricSnapshots)
            .values({
              id: randomUUID(),
              runId,
              scopeType: row.scopeType,
              scopeId: row.scopeId,
              metricNamespace: row.metricNamespace,
              metricKey: row.metricKey,
              numericValue: row.numericValue,
              textValue: row.textValue,
              valueState: row.valueState,
              unit: row.unit,
              sourceType: run.sourceType,
              sourceReference: run.sourceReference,
              observedAt: run.observedAt,
              collectedAt,
              metadataJson: row.metadata ? JSON.stringify(row.metadata) : null,
            })
            .onConflictDoNothing()
            .run();
        }
        const completion = { status: "completed", completedAt, metricCount: rows.length, error: null };
        if (existing) tx.update(schema.analyticsRuns).set(completion).where(eq(schema.analyticsRuns.id, existing.id)).run();
        else tx.insert(schema.analyticsRuns).values({ ...run, ...completion }).run();
      });
      return findRun(run.idempotencyKey)!;
    },

    /** Stored values of one run, keyed by metric (read-only; used to detect provider restatements). */
    listRunMetricValues(runId: string): Map<string, number | null> {
      const rows = db.select({ metricKey: schema.analyticsMetricSnapshots.metricKey, numericValue: schema.analyticsMetricSnapshots.numericValue })
        .from(schema.analyticsMetricSnapshots).where(eq(schema.analyticsMetricSnapshots.runId, runId)).all() as { metricKey: string; numericValue: number | null }[];
      return new Map(rows.map((r) => [r.metricKey, r.numericValue]));
    },

    /** Run ids already holding snapshots at this identity (scope, namespace, observedAt, source) - read-only. */
    listSnapshotRunIdsAt(scopeType: string, scopeId: string, metricNamespace: string, observedAt: string, sourceReference: string): string[] {
      const rows = db.selectDistinct({ runId: schema.analyticsMetricSnapshots.runId }).from(schema.analyticsMetricSnapshots).where(and(
        eq(schema.analyticsMetricSnapshots.scopeType, scopeType), eq(schema.analyticsMetricSnapshots.scopeId, scopeId),
        eq(schema.analyticsMetricSnapshots.metricNamespace, metricNamespace), eq(schema.analyticsMetricSnapshots.observedAt, observedAt),
        eq(schema.analyticsMetricSnapshots.sourceReference, sourceReference))).all() as { runId: string | null }[];
      return rows.map((r) => r.runId).filter((id): id is string => Boolean(id));
    },

    /** Best-effort failure record outside the (rolled back) snapshot transaction. */
    recordFailedRun(run: Omit<AnalyticsRunRecord, "status" | "completedAt" | "metricCount" | "error">, error: string): void {
      const existing = findRun(run.idempotencyKey);
      if (existing) {
        if (existing.status !== "completed") db.update(schema.analyticsRuns).set({ status: "failed", error }).where(eq(schema.analyticsRuns.id, existing.id)).run();
        return;
      }
      db.insert(schema.analyticsRuns).values({ ...run, status: "failed", metricCount: 0, error }).onConflictDoNothing().run();
    },

    listProductHistory(productId: string, query: { metricKey?: string; from?: string; to?: string; limit: number }) {
      const t = schema.analyticsMetricSnapshots;
      // Stage 3A: product history also includes external listing metrics mapped to this product.
      const filters = [or(and(eq(t.scopeType, "product"), eq(t.scopeId, productId)), and(like(t.scopeType, "external_%"), sql`json_extract(${t.metadataJson}, '$.productId') = ${productId}`))!];
      if (query.metricKey) filters.push(eq(t.metricKey, query.metricKey));
      if (query.from) filters.push(gte(t.observedAt, query.from));
      if (query.to) filters.push(lte(t.observedAt, query.to));
      return (db.select().from(t).where(and(...filters)).orderBy(asc(t.observedAt), asc(t.metricNamespace), asc(t.metricKey)).limit(query.limit).all() as any[]).map((r) => ({
        scopeType: r.scopeType,
        scopeId: r.scopeId,
        metricNamespace: r.metricNamespace,
        metricKey: r.metricKey,
        numericValue: r.numericValue,
        textValue: r.textValue,
        valueState: r.valueState,
        unit: r.unit,
        sourceType: r.sourceType,
        sourceReference: r.sourceReference,
        observedAt: r.observedAt,
        collectedAt: r.collectedAt,
        runId: r.runId,
        metadata: r.metadataJson ? JSON.parse(r.metadataJson) : null,
      }));
    },
  });
}
