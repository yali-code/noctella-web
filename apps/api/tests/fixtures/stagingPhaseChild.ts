/** Guarded external staging fixture. Real owners/transactions; never imported by the API runtime. */
import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { refuseUnlessStaging, parseCase } from "../../../../scripts/photo-staging-acceptance/park-at-intent.mjs";

let checkpoint="guards";
async function main() {
  refuseUnlessStaging();
  const c = JSON.parse(process.env.F2_PARK_CASE!);
  parseCase([c.workflow, c.phase, c.subjectId, c.actorId, ...(c.image ? [c.image] : [])]);
  const driver = process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? "postgres" : "sqlite";
  checkpoint="database";
  let db: any;
  // Existing DB only: unlike db/client bootstrap, this fixture never creates/applies a schema.
  if (driver === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(process.env.DATABASE_URL!, { fileMustExist: true }); raw.pragma("foreign_keys = ON");
    db = (await import("drizzle-orm/better-sqlite3")).drizzle(raw,{schema:await import("../../src/db/schema.sqlite")});
  } else {
    const { Pool } = (await import("pg")).default;
    const pool = new Pool({ connectionString: process.env.DATABASE_DRIVER === "supabase-postgres" ? process.env.SUPABASE_DATABASE_URL : process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
    db = (await import("drizzle-orm/node-postgres")).drizzle(pool,{schema:await import("../../src/db/schema.postgres")});
  }
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;
  const { authenticateExecutorExit, sealedArtifactPath } = await import("../../src/services/photoPublicationExecutor");
  const { ownedPhotoArtifactProof } = await import("../../src/services/ownedPhotoArtifactProof");
  const root = path.resolve(process.env.PRODUCT_PHOTO_DIR!);
  checkpoint="freshness";
  let productId = c.subjectId, stagedIds: string[] = [];
  if (c.workflow === "w4") {
    const [intake] = await q(sql`SELECT status, result_product_id FROM ai_product_intakes WHERE id = ${c.subjectId}`);
    if (intake?.status !== "applied" || !intake.result_product_id) throw Error();
    productId = intake.result_product_id;
    stagedIds = (await q(sql`SELECT id FROM ai_intake_photos WHERE intake_id = ${c.subjectId} ORDER BY created_at, id`)).map(r => r.id);
    if (stagedIds.length !== 1) throw Error();
    for (const id of stagedIds) if ((await q(sql`SELECT id FROM photo_operations WHERE subject_type = 'ai_intake_photo' AND subject_id = ${id}`)).length) throw Error();
    if ((await q(sql`SELECT id FROM product_photos WHERE product_id = ${productId}`)).length) throw Error();
  } else if ((await q(sql`SELECT id FROM photo_operations WHERE subject_type = 'w2_request' AND subject_id = ${c.token}`)).length) throw Error();
  const [product] = await q(sql`SELECT title FROM products WHERE id = ${productId}`);
  if (!product?.title?.startsWith("F2 synthetic ") || !(await q(sql`SELECT id FROM admin_users WHERE id = ${c.actorId}`)).length) throw Error();
  if(c.workflow === "w4") {
    const {createIntakeScopedPhotoStorageKeyResolver}=await import("../../src/services/aiIntakePhotoStorageKeyResolver");
    const resolver=createIntakeScopedPhotoStorageKeyResolver(db,c.subjectId);
    for(const id of stagedIds){const key=await resolver.resolve(id);if(!key || path.isAbsolute(key))throw Error();const source=path.resolve(process.env.AI_INTAKE_PHOTO_DIR!,key),relative=path.relative(process.env.AI_INTAKE_PHOTO_DIR!,source);if(relative.startsWith("..") || path.isAbsolute(relative))throw Error();const st=fs.lstatSync(source);if(!st.isFile() || st.isSymbolicLink() || st.size<1 || st.size>92160)throw Error();}
  }
  const subject = c.workflow === "w2" ? c.token : stagedIds[0];
  async function prove() {
    checkpoint="boundary-authority";
    const ops = await q(sql`SELECT o.id, o.generation, o.owner, o.nonce, o.seal_id, o.main_key, o.thumb_key, o.target_photo_id, o.state AS operation_state,
      i.main_key AS intent_main_key, i.thumb_key AS intent_thumb_key, i.main_dev AS intent_main_dev, i.main_ino AS intent_main_ino, i.main_sha256 AS intent_main_sha256, i.thumb_dev AS intent_thumb_dev, i.thumb_ino AS intent_thumb_ino, i.thumb_sha256 AS intent_thumb_sha256,
      i.state, i.executor_epoch, i.executor_token, i.executor_identity, i.generation AS intent_generation, i.owner AS intent_owner, i.nonce AS intent_nonce, i.seal_id AS intent_seal,
      a.main_dev, a.main_ino, a.main_sha256, a.main_bytes, a.thumb_dev, a.thumb_ino, a.thumb_sha256, a.thumb_bytes
      FROM photo_operations o JOIN photo_publication_intents i ON i.operation_id=o.id JOIN photo_operation_artifacts a ON a.id=o.seal_id AND a.operation_id=o.id AND a.generation=o.generation
      WHERE o.subject_id = ${subject}`);
    if (ops.length !== 1) throw Error();
    const op = ops[0], committed = c.phase === "committed-ack-loss";
    if (String(op.generation) !== "1" || String(op.executor_epoch) !== "1" || String(op.intent_generation) !== String(op.generation) || op.owner !== op.intent_owner || op.nonce !== op.intent_nonce || op.seal_id !== op.intent_seal || op.state !== (committed ? "committed" : "authorized") || op.operation_state !== (committed ? "committed" : "sealed")) throw Error();
    if (authenticateExecutorExit({ token: op.executor_token, executorIdentity: op.executor_identity }).proven) throw Error();
    const copies = await q(sql`SELECT artifact, copy_dev, copy_ino, copy_birth_ns, staging_name, sha256, bytes, executor_epoch FROM photo_publication_copies WHERE operation_id=${op.id} ORDER BY artifact`);
    const expected = c.phase === "before-publication" ? 0 : c.phase === "after-main" ? 1 : 2;
    if (copies.length !== expected) throw Error();
    checkpoint="boundary-files";
    const artifacts: any[] = [];
    for (const artifact of ["main", "thumb"]) {
      for(const suffix of ["key","dev","ino","sha256"]) if(op["intent_"+artifact+"_"+suffix] !== op[artifact+"_"+suffix]) throw Error();
      const key = op[artifact + "_key"], canonical = path.join(root, key), copy = copies.find(r => r.artifact === artifact);
      if (!committed) {
        const source = await ownedPhotoArtifactProof(sealedArtifactPath(root, {operationId:op.id,generation:1}, artifact as "main"|"thumb"), true);
        if (source.dev !== op[artifact+"_dev"] || source.ino !== op[artifact+"_ino"] || source.sha256 !== op[artifact+"_sha256"] || String(source.bytes) !== String(op[artifact+"_bytes"])) throw Error();
      }
      if (!copy) { if (fs.existsSync(canonical)) throw Error(); continue; }
      const proof = await ownedPhotoArtifactProof(canonical, true);
      if (proof.dev !== copy.copy_dev || proof.ino !== copy.copy_ino || proof.sha256 !== copy.sha256 || String(proof.bytes) !== String(copy.bytes) || proof.sha256 !== op[artifact+"_sha256"] || String(proof.bytes) !== String(op[artifact+"_bytes"]) || proof.ino === op[artifact+"_ino"] || String(copy.executor_epoch) !== "1") throw Error();
      if (!committed) {
        if (!/^data-[0-9a-f]{16}$/.test(copy.staging_name)) throw Error();
        const anchor = path.join(path.dirname(root), ".product-photo-publication", op.id, artifact, copy.staging_name);
        const a = fs.lstatSync(anchor, {bigint:true}), b = fs.lstatSync(canonical, {bigint:true});
        if (!a.isFile() || a.isSymbolicLink() || a.dev !== b.dev || a.ino !== b.ino || String(b.birthtimeNs) !== copy.copy_birth_ns) throw Error();
      }
      artifacts.push({artifact,key,...proof,anchorRequired:!committed});
    }
    checkpoint="boundary-effects";
    const photos = await q(sql`SELECT id FROM product_photos WHERE id = ${op.target_photo_id}`);
    const events = await q(sql`SELECT id FROM outbox_events WHERE aggregate_id = ${op.target_photo_id} AND event_type = 'product_photo.promote_requested'`);
    if (photos.length !== (committed?1:0) || events.length !== (committed?1:0)) throw Error();
    return { workflow:c.workflow,phase:c.phase,productId,...(c.workflow==="w4"?{intakeId:c.subjectId,stagedPhotoIds:stagedIds}:{}),cleanupBoundary:"not-tested",operations:[{operationId:op.id,generation:String(op.generation),epoch:String(op.executor_epoch),owner:op.owner,nonce:op.nonce,sealId:op.seal_id,executorToken:op.executor_token,executorIdentity:op.executor_identity,photoId:op.target_photo_id,state:op.state,scopeLive:true,photos:photos.length,outbox:events.length,copies,artifacts}] };
  }
  const park = async () => {
    const proof = await prove();
    setInterval(() => undefined, 60000); // IPC/pending promises alone do not prove a live executor.
    process.on("message", async (m:any) => {
      if (m?.event !== "PROVE_LIVE" || typeof m.challenge !== "string") return;
      try { process.send?.({event:"LIVE",challenge:m.challenge,proof:await prove()}); } catch { process.send?.({event:"PROOF_FAILED"}); }
    });
    process.send?.({event:"BOUNDARY",proof});
    return new Promise<never>(() => undefined);
  };
  const hooks = { afterIntent: () => c.phase === "before-publication" ? park() : undefined,
    copyPhase: (...args:any[]) => { const [artifact,phase] = args.slice(-2); return c.phase === "after-main" && artifact === "main" && phase === "linked" ? park() : undefined; },
    afterPublish: () => c.phase === "after-both" ? park() : undefined,
    afterCommit: () => c.phase === "committed-ack-loss" ? park() : undefined };
  checkpoint="owner";
  if (c.workflow === "w2") {
    const input = path.join(c.workDir,"input"); fs.copyFileSync(c.image,input,fs.constants.COPYFILE_EXCL); const bytes=fs.statSync(input).size;
    const file={path:input,workDir:c.workDir,size:bytes,mimetype:"image/jpeg",signal:new AbortController().signal};
    const { digestW2StagedInput }=await import("../../src/services/w2StagedInputDigest");
    const { uploadFencedProductPhoto }=await import("../../src/services/w2FencedProductPhotoOwner");
    await uploadFencedProductPhoto(db,{productId,actorId:c.actorId,operationToken:c.token,sha256:await digestW2StagedInput(file,90*1024),altText:"",file},{driver,hooks});
  } else {
    const { finalizeAiIntakePhotos }=await import("../../src/services/aiIntakePhotoFinalization");
    await finalizeAiIntakePhotos(db,c.subjectId,{},c.actorId,undefined,{driver,hooks});
  }
  throw Error(); // A requested boundary must never silently turn into normal completion.
}
main().catch(() => { process.send?.({event:"PROOF_FAILED",checkpoint}); process.exitCode=2; });
