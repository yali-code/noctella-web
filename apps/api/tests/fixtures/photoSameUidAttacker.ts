/**
 * #472 test fixture: a hostile preparer running under the API's UID. It attacks published bytes and authority material
 * directly (not through the protocol) and reports which attempts succeeded. Run unconfined (negative control) and
 * through the real Landlock launcher.
 */
import fs from "node:fs";

const { probe } = JSON.parse(Buffer.from(process.env.PHOTO_PREPARATION_JOB ?? "", "base64").toString("utf8"));
const attempt = (fn: () => string) => { try { return fn(); } catch (e: any) { return String(e?.code ?? e); } };
const overwrite = (file: string) => { const fd = fs.openSync(file, "r+"); try { fs.writeSync(fd, "TAMPERED", 0); } finally { fs.closeSync(fd); } return "WRITTEN"; };
const report = {
  canonicalInPlace: attempt(() => overwrite(probe.canonicalFile)),
  stagingAnchor: attempt(() => overwrite(probe.anchorFile)),
  apiDescriptorReopen: attempt(() => overwrite(`/proc/${probe.apiPid}/fd/${probe.apiFd}`)),
  apiEnvironment: attempt(() => fs.readFileSync(`/proc/${probe.apiPid}/environ`, "utf8").includes("PATH=") ? "READ" : "EMPTY"),
};
process.stdout.write(JSON.stringify({ ok: false, status: 500, code: "ATTACK_REPORT", message: JSON.stringify(report) }) + "\n");
