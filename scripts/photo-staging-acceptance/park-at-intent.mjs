// Stage 5 F2 closure Stage 1 — STAGING-ONLY deterministic executor-loss setup (external orchestration, no runtime
// endpoint, no production code path). Forks the EXISTING SIGKILL fixture (apps/api/tests/fixtures/w2SigkillChild.ts),
// which runs the REAL W2 owner against the service's own database/disk and parks at the exact `afterIntent` boundary:
// the durable publication intent is authorized and no canonical name exists yet. Run it in the staging service shell
// from apps/api (dev dependencies present: tsx). It prints one PARKED line with the child's PID and the token, then
// stays attached. The operator then EITHER kills that PID (same-instance loss: the API proves the death itself) OR
// restarts the service (cross-instance loss: BLOCKED until an evidenced operator attestation).
//
//   cd apps/api && F2_STAGING_ACCEPTANCE=enabled node ../../scripts/photo-staging-acceptance/park-at-intent.mjs \
//     <productId> <image.jpg (<= 90 KB)> <adminUserId>
//
// Fails closed unless: F2_STAGING_ACCEPTANCE=enabled; Render's injected RENDER_SERVICE_ID is present, is not the production
// service and equals the operator-named F2_STAGING_TARGET_SERVICE_ID; protected mode is ON with MANDATORY confined
// preparation (PHOTO_PREPARATION_CONFINEMENT=required + PHOTO_PREPARATION_LAUNCHER); DATABASE_URL and PRODUCT_PHOTO_DIR
// are set (the child uses exactly the service's database and roots). Interrupting this orchestrator leaves the child
// parked: it never deletes intents, anchors, private files or any durable state; only its own input temp dir is removed
// when the child exits.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRODUCTION_SERVICE_ID = "srv-db34390m7kps73cv8l6g";
export function refuseUnlessStaging(env = process.env) {
  if (env.F2_STAGING_ACCEPTANCE !== "enabled") throw new Error("refused: set F2_STAGING_ACCEPTANCE=enabled (staging only)");
  if (!env.RENDER_SERVICE_ID) throw new Error("refused: RENDER_SERVICE_ID is absent (service identity unknown)");
  if (env.RENDER_SERVICE_ID === PRODUCTION_SERVICE_ID) throw new Error("refused: this is the production service");
  if (env.RENDER_SERVICE_ID !== env.F2_STAGING_TARGET_SERVICE_ID) throw new Error("refused: RENDER_SERVICE_ID does not match F2_STAGING_TARGET_SERVICE_ID");
  if (env.PHOTO_OWNERSHIP_FENCING_ENABLED !== "true") throw new Error("refused: protected mode (fencing) is not enabled on this service");
  if (env.PHOTO_PREPARATION_CONFINEMENT !== "required" || !env.PHOTO_PREPARATION_LAUNCHER) throw new Error("refused: mandatory confined preparation is not configured");
  if (!env.DATABASE_URL || !env.PRODUCT_PHOTO_DIR) throw new Error("refused: DATABASE_URL and PRODUCT_PHOTO_DIR must be set explicitly");
}

if (process.argv[1]?.endsWith("park-at-intent.mjs")) {
  try {
    refuseUnlessStaging();
    const [productId, image, actorId] = process.argv.slice(2);
    if (!productId || !image || !actorId) throw new Error("usage: park-at-intent.mjs <productId> <image> <adminUserId>");
    const bytes = fs.readFileSync(image);
    if (bytes.length > 90 * 1024) throw new Error("image must be <= 90 KB (it travels base64 in the child's environment)");
    const fixture = path.resolve("tests/fixtures/w2SigkillChild.ts");
    if (!fs.existsSync(fixture)) throw new Error("run from apps/api (fixture not found)");
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "f2-park-"));
    const token = `f2-park-${randomUUID()}`;
    const child = fork(fixture, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, F5_KILL_STAGE: "afterIntent", F5_TOKEN: token, F5_PRODUCT_ID: productId, F5_ACTOR_ID: actorId, F5_WORK_DIR: workDir, F5_INPUT_BASE64: bytes.toString("base64") } });
    child.on("message", (m) => {
      if (m === "at:afterIntent") console.log(JSON.stringify({ event: "PARKED", stage: "afterIntent", childPid: child.pid, idempotencyKey: token, next: "kill -9 <childPid> (same-instance) OR restart the service (cross-instance); then retry the same key with the same image" }));
      else console.log(JSON.stringify({ event: "CHILD", message: String(m) }));
    });
    child.on("exit", (code, signal) => { console.log(JSON.stringify({ event: "CHILD_EXIT", code, signal })); fs.rmSync(workDir, { recursive: true, force: true }); });
    process.on("SIGINT", () => { console.log(JSON.stringify({ event: "ORCHESTRATOR_INTERRUPTED", childPid: child.pid, note: "child left parked; durable state untouched; kill it explicitly" })); process.exit(130); });
  } catch (e) { console.log(JSON.stringify({ event: "REFUSED", message: String(e.message ?? e) })); process.exitCode = 2; }
}
