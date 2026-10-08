import { and, asc, desc, eq, or } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";

/**
 * Analytics Stage 3 PR-2: SQLite persistence for the experiment registry and Knowledge Memory.
 * Writes only analytics_experiment* and knowledge_* tables; better-sqlite3 transaction callbacks
 * stay synchronous. Idempotency is enforced by unique indexes (observation key, result per
 * experiment, research run key, finding fingerprint, conflict pair).
 */
export function createSqliteIntelligenceRepository(db: any) {
  const e = schema.analyticsExperiments, v = schema.analyticsExperimentVariants, o = schema.analyticsExperimentObservations, r = schema.analyticsExperimentResults;
  const f = schema.knowledgeFindings, runs = schema.knowledgeResearchRuns, c = schema.knowledgeConflicts;

  return Object.freeze({
    insertExperiment(experiment: typeof e.$inferInsert, variants: (typeof v.$inferInsert)[]) {
      db.transaction((tx: any) => {
        tx.insert(e).values(experiment).run();
        for (const variant of variants) tx.insert(v).values(variant).run();
      });
    },
    getExperiment(id: string) { return db.select().from(e).where(eq(e.id, id)).get() ?? null; },
    listExperiments() { return db.select().from(e).orderBy(desc(e.createdAt), asc(e.id)).all() as any[]; },
    listVariants(experimentId: string) { return db.select().from(v).where(eq(v.experimentId, experimentId)).orderBy(asc(v.variantKey)).all() as any[]; },
    /** Optimistic transition: only succeeds from the expected status. */
    transition(id: string, from: string, set: Partial<typeof e.$inferInsert>): boolean {
      return db.update(e).set(set).where(and(eq(e.id, id), eq(e.status, from))).run().changes === 1;
    },
    findObservation(experimentId: string, observationKey: string) { return db.select().from(o).where(and(eq(o.experimentId, experimentId), eq(o.observationKey, observationKey))).get() ?? null; },
    insertObservation(row: typeof o.$inferInsert): boolean { return db.insert(o).values(row).onConflictDoNothing().run().changes === 1; },
    listObservations(experimentId: string) { return db.select().from(o).where(eq(o.experimentId, experimentId)).orderBy(asc(o.observedAt), asc(o.observationKey)).all() as any[]; },
    getResult(experimentId: string) { return db.select().from(r).where(eq(r.experimentId, experimentId)).get() ?? null; },
    /** Finalization is atomic and idempotent: one result per experiment, status moves to `toStatus`. */
    finalize(experimentId: string, fromStatus: string, toStatus: string, result: typeof r.$inferInsert, endedAt: string): boolean {
      let written = false;
      db.transaction((tx: any) => {
        if (tx.select().from(r).where(eq(r.experimentId, experimentId)).get()) return;
        if (tx.update(e).set({ status: toStatus, endedAt, updatedAt: endedAt }).where(and(eq(e.id, experimentId), eq(e.status, fromStatus))).run().changes !== 1) return;
        tx.insert(r).values(result).run();
        written = true;
      });
      return written;
    },

    findRun(idempotencyKey: string) { return db.select().from(runs).where(eq(runs.idempotencyKey, idempotencyKey)).get() ?? null; },
    getFinding(id: string) { return db.select().from(f).where(eq(f.id, id)).get() ?? null; },
    findFindingByFingerprint(fingerprint: string) { return db.select().from(f).where(eq(f.fingerprint, fingerprint)).get() ?? null; },
    listFindings(filters: { topicDomain?: string; classification?: string; status?: string }) {
      const where = [filters.topicDomain && eq(f.topicDomain, filters.topicDomain), filters.classification && eq(f.classification, filters.classification), filters.status && eq(f.status, filters.status)].filter(Boolean);
      return db.select().from(f).where(where.length ? and(...(where as any[])) : undefined).orderBy(desc(f.lastConfirmedAt), asc(f.id)).limit(1000).all() as any[];
    },
    listConflicts(state?: string) { return db.select().from(c).where(state ? eq(c.state, state) : undefined).orderBy(asc(c.notedAt)).all() as any[]; },
    conflictsForFinding(findingId: string) { return db.select().from(c).where(or(eq(c.findingAId, findingId), eq(c.findingBId, findingId))).all() as any[]; },

    /**
     * One research run, atomically: new findings inserted; already-known findings (same fingerprint)
     * only get their confirmation pointer/time updated; superseded findings are marked SUPERSEDED (kept,
     * never deleted); conflicts are stored as OPEN pairs. The run row makes a retry a no-op.
     */
    writeResearchRun(run: typeof runs.$inferInsert, ops: { inserts: (typeof f.$inferInsert)[]; confirmations: { id: string }[]; supersede: string[]; conflicts: { id: string; a: string; b: string }[] }, completedAt: string) {
      db.transaction((tx: any) => {
        tx.insert(runs).values({ ...run, status: "completed", completedAt, findingCount: ops.inserts.length + ops.confirmations.length }).run();
        for (const row of ops.inserts) tx.insert(f).values(row).run();
        for (const { id } of ops.confirmations) tx.update(f).set({ lastConfirmedRunId: run.id, lastConfirmedAt: completedAt, updatedAt: completedAt }).where(eq(f.id, id)).run();
        for (const id of ops.supersede) tx.update(f).set({ status: "SUPERSEDED", updatedAt: completedAt }).where(eq(f.id, id)).run();
        for (const k of ops.conflicts) tx.insert(c).values({ id: k.id, findingAId: k.a, findingBId: k.b, state: "OPEN", notedAt: completedAt }).onConflictDoNothing().run();
      });
      return db.select().from(runs).where(eq(runs.id, run.id)).get();
    },
  });
}
