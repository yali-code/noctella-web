import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import { createSqliteAnalyticsSnapshotRepository } from "../repositories/analytics/analyticsSnapshotsSqlite";
import { ExternalCollectorError, externalRunIdempotencyKey, normalizeExternalCollection, type ExternalAnalyticsCollector } from "../use-cases/analytics/externalMetrics";
import { decryptCredential } from "./credentialEncryption";

/**
 * Analytics Stage 3A: runs one external platform collector against the platform's connected
 * marketplace connection and stores its observations in the existing analytics_runs /
 * analytics_metric_snapshots tables (sourceType "external_platform"). Idempotent per platform +
 * connection + source + window/observation: a retry replays the completed run. A collector failure
 * records a failed run (typed kind only - never token or provider body) and writes no metrics.
 */
export async function runExternalAnalyticsCollection(db: DbClient, collector: ExternalAnalyticsCollector, options: { now?: Date; collectedAt?: Date } = {}) {
  const now = options.now ?? new Date();
  const collectedAt = options.collectedAt ?? now;
  const platform = collector.platform;
  const repo = createSqliteAnalyticsSnapshotRepository(db);
  const connection = repo.findConnectedConnection(platform);
  if (!connection) throw new ExternalCollectorError("not_connected", `No connected ${platform} marketplace connection`);

  const failureRun = { id: randomUUID(), runType: `external_${platform}_metrics`, sourceType: "external_platform", sourceReference: `${platform}.collector`, idempotencyKey: `external-failure:${platform}:${connection.id}:${collectedAt.toISOString()}`, observedAt: now.toISOString(), startedAt: collectedAt.toISOString() };
  const fail = (error: ExternalCollectorError): never => {
    repo.recordFailedRun(failureRun, `${error.kind}: ${error.message}`.slice(0, 500));
    throw error;
  };

  let accessToken: string;
  try {
    accessToken = decryptCredential(connection.encryptedAccessToken);
  } catch {
    return fail(new ExternalCollectorError("authentication", "Stored connection credential could not be decrypted"));
  }

  let result;
  try {
    result = await collector.collect({ connectionId: connection.id, accessToken, now });
  } catch (error) {
    return fail(error instanceof ExternalCollectorError ? error : new ExternalCollectorError("temporary", "Collector failed"));
  }

  const idempotencyKey = externalRunIdempotencyKey(platform, connection.id, result);
  const existing = repo.findRun(idempotencyKey);
  if (existing?.status === "completed") return { run: existing, replayed: true, warnings: [...result.warnings] };

  let normalized;
  try {
    normalized = normalizeExternalCollection(result, connection.id, repo.mapExternalListings(platform, result.observations.map((o) => o.externalEntityId)));
  } catch (error) {
    return fail(error instanceof ExternalCollectorError ? error : new ExternalCollectorError("malformed_payload", "Collector result could not be normalized"));
  }

  const run = { id: randomUUID(), runType: `external_${platform}_metrics`, sourceType: "external_platform", sourceReference: result.sourceReference, idempotencyKey, observedAt: result.observedAt, startedAt: collectedAt.toISOString() };
  return { run: repo.writeCompletedRun(run, new Date().toISOString(), collectedAt.toISOString(), normalized.rows), replayed: false, warnings: normalized.warnings };
}
