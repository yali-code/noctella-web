// External staging-only orchestration. No endpoint, runtime fault flag, DB repair or cleanup.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const PRODUCTION_SERVICE_ID = "srv-db34390m7kps73cv8l6g";
export const PHASES = ["before-publication", "after-main", "after-both", "committed-ack-loss"];
export function refuseUnlessStaging(env = process.env) {
  if (env.F2_STAGING_ACCEPTANCE !== "enabled") throw Error("refused: set F2_STAGING_ACCEPTANCE=enabled (staging only)");
  if (!env.RENDER_SERVICE_ID) throw Error("refused: RENDER_SERVICE_ID is absent (service identity unknown)");
  if (env.RENDER_SERVICE_ID === PRODUCTION_SERVICE_ID) throw Error("refused: this is the production service");
  if (!/^srv-[a-z0-9]{8,40}$/.test(env.RENDER_SERVICE_ID) || env.RENDER_SERVICE_ID !== env.F2_STAGING_TARGET_SERVICE_ID) throw Error("refused: RENDER_SERVICE_ID does not match F2_STAGING_TARGET_SERVICE_ID");
  if (env.PHOTO_OWNERSHIP_FENCING_ENABLED !== "true") throw Error("refused: protected mode (fencing) is not enabled on this service");
  if (env.PHOTO_PREPARATION_CONFINEMENT !== "required" || !env.PHOTO_PREPARATION_LAUNCHER) throw Error("refused: mandatory confined preparation is not configured");
  if (!env.DATABASE_URL || !env.PRODUCT_PHOTO_DIR || !path.isAbsolute(env.PRODUCT_PHOTO_DIR)) throw Error("refused: DATABASE_URL and absolute PRODUCT_PHOTO_DIR must be set explicitly");
  const driver = env.DATABASE_DRIVER ?? "sqlite";
  if (!["sqlite", "postgres", "supabase-postgres"].includes(driver)) throw Error("refused: unsupported database driver");
  if (driver === "sqlite" && (!path.isAbsolute(env.DATABASE_URL) || !fs.existsSync(env.DATABASE_URL))) throw Error("refused: explicit existing SQLite DATABASE_URL required");
  if (driver !== "sqlite") { const value = driver === "supabase-postgres" ? env.SUPABASE_DATABASE_URL : env.DATABASE_URL; let u; try { u = new URL(value); } catch {} if (!u || !["postgres:", "postgresql:"].includes(u.protocol)) throw Error("refused: explicit PostgreSQL URL required"); }
}
export function parseCase(argv, env = process.env) {
  const [workflow, phase, subjectId, actorId, image] = argv;
  if (!["w2", "w4"].includes(workflow) || !PHASES.includes(phase)) throw Error("refused: explicit workflow w2|w4 and supported phase required; lost-cleanup is unsupported");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(subjectId ?? "") || !uuid.test((actorId ?? "").replace(/^adminuser_/,"")) || argv.length !== (workflow === "w2" ? 5 : 4)) throw Error("refused: one subject UUID and actor UUID required (W2 also requires one synthetic JPEG)");
  if (env.F2_STAGING_SYNTHETIC_CASE !== "confirmed") throw Error("refused: F2_STAGING_SYNTHETIC_CASE=confirmed required");
  if (workflow === "w4" && (!env.AI_INTAKE_PHOTO_DIR || !path.isAbsolute(env.AI_INTAKE_PHOTO_DIR))) throw Error("refused: explicit absolute AI_INTAKE_PHOTO_DIR required");
  if (workflow === "w2") { const st = fs.lstatSync(image); if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > 90 * 1024) throw Error("refused: one regular synthetic JPEG of 1..92160 bytes required"); }
  return { workflow, phase, subjectId, actorId, ...(image ? { image: path.resolve(image) } : {}) };
}
export function startPark(caseInput, { env = process.env, emit = data => console.log(JSON.stringify(data)), forkChild = fork, deadlineMs = 120000, onFailure = () => {} } = {}) {
  refuseUnlessStaging(env);
  const selected = parseCase(caseInput, env);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f2-park-"));
  fs.chmodSync(workDir, 0o700);
  const token = `f2-park-${randomUUID()}`;
  const fixture = fileURLToPath(new URL("../../apps/api/tests/fixtures/stagingPhaseChild.ts", import.meta.url));
  const child = forkChild(fixture, [], { cwd: path.resolve(path.dirname(fixture), "../.."), execArgv: ["--import", "tsx"], detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...env, F2_PARK_CASE: JSON.stringify({ ...selected, token, workDir }) } });
  emit({event:"CHILD_STARTED",childPid:child.pid,workflow:selected.workflow,phase:selected.phase});
  let state = "starting", challenge, first;
  const preserve = (event,checkpoint) => { clearTimeout(timer); state = "failed"; emit({ event, childPid: child.pid, ...(typeof checkpoint==="string" && /^[a-z-]{1,40}$/.test(checkpoint)?{checkpoint}:{}), preserved: true, note: "child and all files/state retained; no automatic kill or cleanup" }); if(child.connected) child.disconnect(); child.unref(); onFailure(); };
  const timer = setTimeout(() => preserve("ORCHESTRATION_TIMEOUT"), deadlineMs);
  child.on("message", m => {
    if(state === "failed") return;
    if (m?.event === "BOUNDARY" && state === "starting") { first = m.proof; state = "challenging"; challenge = randomUUID(); child.send({ event: "PROVE_LIVE", challenge }); }
    else if (m?.event === "LIVE" && state === "challenging" && m.challenge === challenge && JSON.stringify(m.proof) === JSON.stringify(first)) {
      try { process.kill(child.pid, 0); if (!first?.operations?.length || first.workflow !== selected.workflow || first.phase !== selected.phase || first.operations.some(o => !o.executorIdentity?.match(new RegExp(`^px1:[^:]+:[0-9]+:${child.pid}:`)))) throw Error(); }
      catch { preserve("LIVENESS_PROOF_REFUSED"); return; }
      clearTimeout(timer); state = "parked"; emit({ schema: 1, event: "PARKED", childPid: child.pid, live: true, ...first, ...(selected.workflow === "w2" ? { idempotencyKey: token } : {}) });
    } else { preserve("BOUNDARY_PROOF_REFUSED",m?.checkpoint); }
  });
  child.on("error", () => preserve("CHILD_START_FAILED"));
  child.on("exit", (code, signal) => { clearTimeout(timer); emit({ event: "CHILD_EXIT", code, signal, preserved: true }); });
  return { child, interrupt() { clearTimeout(timer); emit({ event: "ORCHESTRATOR_INTERRUPTED", childPid: child.pid, preserved: true }); if (child.connected) child.disconnect(); child.unref(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "linux") throw Error("refused: native Linux execution required");
    const control = startPark(process.argv.slice(2), {onFailure:()=>{process.exitCode=2;}});
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { control.interrupt(); process.exit(signal === "SIGINT" ? 130 : 143); });
  } catch { console.log(JSON.stringify({ event: "REFUSED", reason: "staging guards, explicit phase or input validation failed; no cleanup or repair attempted" })); process.exitCode = 2; }
}
