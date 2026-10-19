/**
 * Stage 5 F2 (#472) operator recovery for publication intents.
 *
 * DEFAULT (read-only): lists authorized and review intents with their executor, and whether THIS process can prove the
 * executor's termination (same boot and PID namespace). Writes nothing.
 *   npm run photos:publication-intents -w apps/api
 *
 * ATTESTATION (trusted-caller boundary, explicit): after an instance/host replacement the runtime cannot observe the
 * previous executor, so its intents stay BLOCKED. An operator who has VERIFIED on the platform that the previous
 * instance is terminated (no process of it can still run or reach the database or PRODUCT_PHOTO_DIR) records that
 * fact for one exact intent epoch and executor identity. It does not move authority by itself: the next retry of the
 * request transfers authority (epoch + 1) and resumes from the durable state. Never attest on a lease expiry, a
 * missing heartbeat or a guess.
 *   npm run photos:publication-intents -w apps/api -- --attest-exit --operation <id> --epoch <n> \
 *     --executor <identity> --operator <name> --evidence "<platform termination record>" --confirm-executor-terminated
 *
 * PRIVILEGE MODEL: the channel is a shell on the API host with the API's database credentials. Anyone with that access
 * can already write photo_executor_exit_records (or any row) directly, so this tool adds no new capability and no
 * token/signature would stop such an actor; its purpose is to prevent OPERATOR MISTAKES. It therefore (1) binds the
 * record to the exact epoch AND executor identity of the current authorized intent (stale/mismatched -> refused, CAS
 * in one transaction), (2) refuses a replay (one record per epoch), (3) refuses when this host can see that executor
 * is still alive, and (4) records the operator's external termination evidence (e.g. the platform's instance/deploy
 * record showing the old instance stopped) in the audit field. The operator name and the confirmation flag are audit
 * labels, not proof. Without such evidence the intent stays BLOCKED.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { inOwnershipTransaction, ownershipDriver, type OwnershipDriver, type Rows } from "../services/photoOperationAuthority";
import { exactPositiveInteger, persistAuthenticatedExecutorExitSteps } from "../services/photoPublicationIntents";
import { authenticateExecutorExit } from "../services/photoPublicationExecutor";

export async function reportPublicationIntents(db: DbClient, driver: OwnershipDriver = ownershipDriver()) {
  const rows = await inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
    return yield sql`SELECT i.operation_id, o.kind, o.subject_type, o.subject_id, i.generation, i.executor_epoch, i.executor_identity, i.executor_token, i.state, i.updated_ms,
      (SELECT COUNT(*) FROM photo_executor_exit_records e WHERE e.operation_id = i.operation_id AND e.executor_epoch = i.executor_epoch) AS exit_records
      FROM photo_publication_intents i JOIN photo_operations o ON o.id = i.operation_id WHERE i.state IN ('authorized', 'review') ORDER BY i.updated_ms`;
  });
  return rows.map((row) => {
    const authorized = row.state === "authorized";
    const local = authorized ? authenticateExecutorExit({ token: row.executor_token, executorIdentity: row.executor_identity }) : null;
    return {
      operationId: row.operation_id, kind: row.kind, subjectType: row.subject_type, subjectId: row.subject_id,
      generation: String(row.generation), epoch: String(row.executor_epoch), executorIdentity: row.executor_identity, state: row.state,
      exitRecorded: Number(row.exit_records) > 0,
      // A retry resumes automatically when the exit is recorded or provable here; otherwise the intent is BLOCKED.
      resumable: authorized ? Number(row.exit_records) > 0 || local!.proven : false,
      blockedReason: authorized && Number(row.exit_records) === 0 && local && !local.proven ? local.reason : null,
    };
  });
}

export interface ExitAttestation { operationId: string; epoch: number; executorIdentity: string; operator: string; evidence: string }

/** Records an operator-verified executor termination for ONE exact authorized intent epoch and identity (CAS). */
export async function attestExecutorExit(db: DbClient, driver: OwnershipDriver, a: ExitAttestation): Promise<{ recorded: boolean; reason?: string }> {
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(a.operator)) throw new Error("PHOTO_ATTESTATION_OPERATOR_INVALID");
  if (typeof a.evidence !== "string" || a.evidence.trim().length < 8 || a.evidence.length > 160 || /[\r\n|]/.test(a.evidence)) throw new Error("PHOTO_ATTESTATION_EVIDENCE_REQUIRED");
  const epoch = exactPositiveInteger(a.epoch);
  return inOwnershipTransaction(db, driver, function* (): Generator<SQL, { recorded: boolean; reason?: string }, Rows> {
    yield sql`SELECT id FROM photo_operations WHERE id = ${a.operationId}${sql.raw(driver === "postgres" ? " FOR UPDATE" : "")}`;
    const [intent] = yield sql`SELECT executor_epoch, executor_identity, executor_token, state FROM photo_publication_intents WHERE operation_id = ${a.operationId}`;
    if (!intent || intent.state !== "authorized") return { recorded: false, reason: "no authorized intent" };
    if (String(intent.executor_epoch) !== String(epoch) || intent.executor_identity !== a.executorIdentity) return { recorded: false, reason: "intent epoch or executor changed" };
    const [existing] = yield sql`SELECT executor_identity FROM photo_executor_exit_records WHERE operation_id = ${a.operationId} AND executor_epoch = ${epoch}`;
    if (existing) return { recorded: false, reason: "exit already recorded" };
    // What this host CAN observe overrides the operator: a visibly live executor is never attested dead.
    const local = authenticateExecutorExit({ token: intent.executor_token, executorIdentity: intent.executor_identity });
    if (!local.proven && /alive|still running/.test(local.reason)) return { recorded: false, reason: `refused: ${local.reason}` };
    yield* persistAuthenticatedExecutorExitSteps(driver, { operationId: a.operationId, epoch, executorIdentity: a.executorIdentity, attestedBy: `operator:${a.operator}|${a.evidence.trim()}`.slice(0, 256) });
    return { recorded: true };
  });
}

export function parseRecoveryArgs(argv: string[]): { mode: "report" } | { mode: "attest"; attestation: ExitAttestation } {
  if (!argv.includes("--attest-exit")) return { mode: "report" };
  const value = (flag: string) => { const i = argv.indexOf(flag); const v = i >= 0 ? argv[i + 1] : undefined; if (!v || v.startsWith("--")) throw new Error(`missing ${flag}`); return v; };
  if (!argv.includes("--confirm-executor-terminated")) throw new Error("attestation requires --confirm-executor-terminated after verifying the previous instance is gone");
  return { mode: "attest", attestation: { operationId: value("--operation"), epoch: exactPositiveInteger(value("--epoch")), executorIdentity: value("--executor"), operator: value("--operator"), evidence: value("--evidence") } };
}

if (require.main === module) {
  (async () => {
    const { db, dbRuntime } = await import("../db/client");
    try {
      const args = parseRecoveryArgs(process.argv.slice(2));
      const result = args.mode === "report"
        ? { readOnly: true, intents: await reportPublicationIntents(db) }
        : { readOnly: false, attestation: args.attestation, ...(await attestExecutorExit(db, ownershipDriver(), args.attestation)) };
      console.log(JSON.stringify(result, null, 2));
    } finally { await dbRuntime.shutdown(); }
  })().catch((error) => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
