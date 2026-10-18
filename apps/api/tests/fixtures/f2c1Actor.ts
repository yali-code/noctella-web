/**
 * #472 F2 Contract 1 proof actor (runtime intents since WP1). One barrier-driven actor process. Each parent command runs one
 * protocol step and replies only after that step's transaction committed (commit -> reply). The parent never
 * learns state from cross-actor IPC arrival order. Started with --require f2c1LinkObserver.cjs.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

type Emit = (kind: string, data: Record<string, unknown>) => number;
const emit = (kind: string, data: Record<string, unknown> = {}) => (globalThis as any).__f2c1Emit(kind, data) as ReturnType<Emit>;

async function main() {
  const { db, dbRuntime } = await import("../../src/db/client");
  const authority = await import("../../src/services/photoOperationAuthority");
  const { stagedProductPhotoStorage } = await import("../../src/services/stagedProductPhotoStorage");
  const protocol = await import("../f2c1/protocol");
  const intents = await import("../../src/services/photoPublicationIntents");
  const driver = process.env.F2C1_DRIVER === "postgres" ? "postgres" as const : "sqlite" as const;
  const canonical = process.env.F2C1_CANONICAL!;
  const actorId = process.env.F2C1_ACTOR_ID!;
  // One executor token per actor attempt, generated before the first T1 and reused for every retry of it.
  const me = { token: process.env.F2C1_TOKEN || randomUUID(), executorIdentity: actorId };
  let op: any, seal: any, prepared: any, held: any;
  const tx = (steps: () => Generator<any, any, any>) => authority.inOwnershipTransaction(db as any, driver, steps);
  const own = (a: any) => { held = a; emit("AUTHORITY", { operationId: a.operationId, epoch: a.epoch, token: a.token, mainKey: a.mainKey, thumbKey: a.thumbKey }); };

  const handlers: Record<string, (args: any) => Promise<unknown>> = {
    async claim(args) {
      const claim: any = await tx(() => protocol.guardedClaimSteps(driver, { ...args, actorId: "actor-1" }, args.ttl ?? authority.PHOTO_OPERATION_LEASE_MS));
      if (claim.kind === "owned") op = claim.op;
      return { kind: claim.kind, op: claim.op };
    },
    async adopt(args) { op = args.op; seal = args.seal; return { ok: true }; },
    async prepareSeal(args) {
      const workDir = args.workDir as string;
      const input = Buffer.from(args.inputBase64, "base64");
      await writeFile(path.join(workDir, "input"), input);
      const generationDir = await authority.createGenerationDirectory(op, canonical);
      prepared = await stagedProductPhotoStorage.prepareFencedProductPhoto(
        { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal } as any, generationDir);
      seal = await authority.sealPreparedArtifacts(db as any, driver, op, prepared);
      if (!seal) throw new Error("SEAL_FENCE_LOST");
      return { sealId: seal.sealId, seal, width: prepared.width, height: prepared.height, sizeBytes: input.length };
    },
    async t1(args) {
      const result: any = await intents.acquirePublicationIntent(db as any, driver, op, seal.sealId, me);
      if (args?.lostAck) { emit("LOST_ACK", { step: "t1" }); return { lostAck: true }; } // committed, result discarded
      if (result.kind === "own") own(result.authority);
      return { kind: result.kind, reason: result.reason, state: result.state };
    },
    async transfer(args) {
      const result: any = await tx(() => intents.transferPublicationAuthoritySteps(driver, args.operationId, args.expectedEpoch, me));
      if (result.kind === "own") own(result.authority);
      return { kind: result.kind };
    },
    async link(args) {
      // The protocol, not the observer, prevents unauthorized links: no authority -> no link code at all.
      if (!held) { emit("REFUSED", { step: "link" }); return { refused: "no-authority" }; }
      if (args?.mode === "real" && prepared && held.epoch === 1) {
        await authority.publishSealedArtifacts(db as any, driver, op, prepared, seal, canonical);
        return { linked: "real-publisher" };
      }
      return { linked: await protocol.executeAuthorizedLinks(db, driver, held, canonical) };
    },
    async linkOne(args) {
      // S5 crash-window helper: the authorized executor links ONE artifact, then the parent kills it.
      if (!held) { emit("REFUSED", { step: "linkOne" }); return { refused: "no-authority" }; }
      const { link } = await import("node:fs/promises");
      await link(protocol.privateArtifactPath(canonical, held, args.artifact), path.join(canonical, args.artifact === "main" ? held.mainKey : held.thumbKey));
      return { linked: args.artifact };
    },
    async t2(args) {
      if (!held) { emit("REFUSED", { step: "t2" }); return { refused: "no-authority" }; }
      const input = { authority: held, productId: args.productId, photoId: args.photoId, eventId: args.eventId ?? randomUUID(), sizeBytes: args.sizeBytes, width: args.width, height: args.height };
      // Like real W2 committed retries: return the durable result BEFORE re-running publication effects.
      const [durable]: any = await tx(function* () { return yield sqlCommitted(held.operationId); });
      if (durable?.state === "committed") return { committed: true, already: true, photoId: durable.committed_photo_id };
      try {
        await protocol.harnessT2(db, driver, { ...input, mainKey: held.mainKey, thumbKey: held.thumbKey }, protocol.intentFence(input));
      } catch (error: any) {
        if (!String(error?.message ?? error).includes("PHOTO_OPERATION_FENCE_LOST")) throw error;
        // Lost T2 acknowledgement retry: the fence no longer matches because T2 already committed.
        const [row]: any = await tx(function* () { return yield sqlCommitted(held.operationId); });
        if (row?.state === "committed") return { committed: true, already: true, photoId: row.committed_photo_id };
        throw error;
      }
      if (args?.lostAck) { emit("LOST_ACK", { step: "t2" }); return { lostAck: true }; }
      emit("COMMITTED", { operationId: held.operationId, epoch: held.epoch });
      return { committed: true };
    },
    async unprotectedPublish() {
      // C0 ONLY: today's unfenced ordering, used to prove the observer detects an unauthorized link.
      await authority.publishSealedArtifacts(db as any, driver, op, prepared, seal, canonical);
      return { linked: "unprotected" };
    },
    async closeDb() { await dbRuntime.shutdown(); return { closed: true }; },
  };

  const { sql } = await import("drizzle-orm");
  const sqlCommitted = (operationId: string) => sql`SELECT state, committed_photo_id FROM photo_operations WHERE id = ${operationId}`;

  process.on("message", async (message: any) => {
    if (message?.type !== "cmd") return;
    try { process.send?.({ type: "reply", id: message.id, ok: true, result: await handlers[message.cmd](message.args) }); }
    catch (error: any) {
      // Driver evidence from the cause chain (drizzle wraps PostgreSQL errors): code and constraint only, never URLs.
      let code = error?.code, constraint: unknown;
      for (let e = error, d = 0; e && d < 5; e = e.cause, d++) { code ??= e.code; constraint ??= e.constraint; }
      process.send?.({ type: "reply", id: message.id, ok: false, error: String(error?.message ?? error), code, constraint });
    }
  });
  process.send?.({ type: "ready", actorId, pid: process.pid });
}
main().catch((error) => { process.send?.({ type: "fatal", error: String(error?.message ?? error) }); process.exitCode = 2; });
