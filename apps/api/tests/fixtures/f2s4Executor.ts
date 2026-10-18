/**
 * #472 F2 Step 4 OFFLINE publication executor. Started as: reaper -> supervisor (--supervise) -> this process, so it
 * runs CONFINED (Landlock allowlist: canonical, staging, private and database/tmp directories) and its exit is
 * authenticated by the Step 2 supervisor. It holds Contract 1 intent authority. One IPC command = one protocol step;
 * the reply is sent only after that step's transaction committed. Without authority it never publishes or commits.
 */
import { randomUUID } from "node:crypto";

async function main() {
  const { db } = await import("../../src/db/client");
  const authority = await import("../../src/services/photoOperationAuthority");
  const c1 = await import("../f2c1/protocol");
  const comp = await import("../f2s4/composition");
  const { sql } = await import("drizzle-orm");
  const driver = process.env.F2S4_DRIVER === "postgres" ? "postgres" as const : "sqlite" as const;
  const canonical = process.env.F2S4_CANONICAL!, staging = process.env.F2S4_STAGING!;
  const actorId = process.env.F2S4_ACTOR_ID!, base = process.env.F2S4_TOKEN || randomUUID();
  const me = (i: number) => ({ token: `${base}:${i}`, actorId });
  const ops: any[] = [], seals: any[] = [], held: any[] = [];
  const tx = (steps: () => Generator<any, any, any>) => c1.inF2c1Transaction(db as any, driver, steps);
  const die = () => process.kill(process.pid, "SIGKILL");
  const committed = async (opId: string) => (await tx(function* () { return yield sql`SELECT state FROM photo_operations WHERE id = ${opId}`; }) as any)[0]?.state === "committed";

  const handlers: Record<string, (a: any) => Promise<unknown>> = {
    async claim(a) {
      const ttl = authority.PHOTO_OPERATION_LEASE_MS;
      const claim: any = a.kind === "w2"
        ? await tx(() => c1.guardedClaimSteps(driver, { token: a.token, productId: a.productId, sha256: a.sha256, actorId: "actor-1", altText: "" }, ttl))
        : await tx(() => comp.guardedClaimW4Steps(driver, a.productId, a.stagedPhotoId, a.sha256, ttl));
      if (claim.kind === "owned") ops[a.i] = claim.op;
      return { kind: claim.kind, op: claim.op };
    },
    async adopt(a) { ops[a.i] = a.op; seals[a.i] = a.seal; return { ok: true }; },
    async genDir(a) { return { dir: await authority.createGenerationDirectory(ops[a.i], canonical) }; },
    async seal(a) {
      const seal = await authority.sealPreparedArtifacts(db as any, driver, ops[a.i], a.files);
      if (!seal) return { sealed: false };
      seals[a.i] = seal; return { sealed: true, seal };
    },
    async t1(a) {
      const r: any = await tx(() => c1.t1Steps(driver, ops[a.i], seals[a.i].sealId, me(a.i)));
      if (a.lostAck) return { lostAck: true };
      if (r.kind === "own") held[a.i] = r.authority;
      return { kind: r.kind };
    },
    async transfer(a) {
      const r: any = await tx(() => c1.transferSteps(driver, a.operationId, a.expectedEpoch, me(a.i)));
      if (r.kind === "own") held[a.i] = r.authority;
      return { kind: r.kind, authority: r.authority };
    },
    async publish(a) {
      if (!held[a.i]) return { refused: "no-authority" }; // the protocol, not a test observer, prevents publication
      return comp.publishAuthorized(db, driver, held[a.i], canonical, staging, (artifact, phase) => { if (a.crashAt === `${artifact}:${phase}`) die(); });
    },
    async t2w2(a) {
      if (!held[a.i]) return { refused: "no-authority" };
      if (await committed(held[a.i].operationId)) return { committed: true, already: true }; // durable result first
      const input = { authority: held[a.i], productId: a.productId, photoId: a.photoId, eventId: randomUUID(), sizeBytes: a.sizeBytes, width: a.width, height: a.height };
      await c1.harnessT2(db, driver, { ...input, mainKey: held[a.i].mainKey, thumbKey: held[a.i].thumbKey }, c1.intentAuthorizedFence(driver, input));
      if (a.crashAfter) die();
      return a.lostAck ? { lostAck: true } : { committed: true };
    },
    async t2w4(a) {
      if (a.entries.some((e: any) => !held[e.i])) return { refused: "no-authority" };
      const [intake]: any = await tx(function* () { return yield sql`SELECT status FROM ai_product_intakes WHERE id = ${a.intakeId}`; });
      if (intake?.status === "finalized") return { committed: true, already: true };
      await comp.harnessT2W4(db, driver, { intakeId: a.intakeId, productId: a.productId, actorId: "admin-finalizer",
        entries: a.entries.map((e: any) => ({ ...e, authority: held[e.i], eventId: randomUUID() })) });
      if (a.crashAfter) die();
      return a.lostAck ? { lostAck: true } : { committed: true };
    },
    async crash() { die(); return {}; },
    async killSupervisor() { process.kill(process.ppid, "SIGKILL"); return { killed: process.ppid }; },
  };
  process.on("message", async (m: any) => {
    if (m?.type !== "cmd") return;
    try { process.send?.({ type: "reply", id: m.id, ok: true, result: await handlers[m.cmd](m.args ?? {}) }); }
    catch (error: any) { process.send?.({ type: "reply", id: m.id, ok: false, error: String(error?.message ?? error) }); }
  });
  process.send?.({ type: "ready", pid: process.pid });
}
main().catch((error) => { process.send?.({ type: "fatal", error: String(error?.message ?? error) }); process.exitCode = 2; });
