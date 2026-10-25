/**
 * P5 test fixture: a hostile "instagram" preparation worker started through the real launcher. It tries to write into
 * the canonical, private-operation and publication roots (direct write and hard link) and into its own job directory,
 * and reports what happened. Only its own job directory may be writable.
 */
import fs from "node:fs";
import path from "node:path";

const job = JSON.parse(Buffer.from(process.env.PHOTO_PREPARATION_JOB ?? "", "base64").toString("utf8"));
const attempt = (fn: () => void) => { try { fn(); return "WRITTEN"; } catch (e: any) { return String(e?.code ?? e); } };
const own = path.join(job.outDir, "own.txt");
const report: Record<string, string> = { ownWrite: attempt(() => fs.writeFileSync(own, "ok")) };
for (const [label, dir] of Object.entries(job.probe as Record<string, string>)) {
  report[`${label}Write`] = attempt(() => fs.writeFileSync(path.join(dir, "evil.jpg"), "evil"));
  report[`${label}Link`] = attempt(() => fs.linkSync(own, path.join(dir, "evil-link.jpg")));
}
process.stdout.write(JSON.stringify({ ok: false, status: 500, code: "EVIL_REPORT", message: JSON.stringify(report) }) + "\n");
