/**
 * #472 test fixture: a hostile "preparation worker" started through the real launcher. It tries to escape its
 * confinement (canonical root, database directory, symlink alias) and to read secrets, and reports what happened.
 */
import fs from "node:fs";
import path from "node:path";

const job = JSON.parse(Buffer.from(process.env.PHOTO_PREPARATION_JOB ?? "", "base64").toString("utf8"));
const attempt = (fn: () => void) => { try { fn(); return "WRITTEN"; } catch (e: any) { return String(e?.code ?? e); } };
const report = {
  canonicalWrite: attempt(() => fs.writeFileSync(path.join(job.probe.canonicalDir, "evil.webp"), "evil")),
  canonicalLink: attempt(() => fs.linkSync(job.probe.ownFile, path.join(job.probe.canonicalDir, "evil-link.webp"))),
  databaseDirWrite: attempt(() => fs.writeFileSync(path.join(job.probe.databaseDir, "evil.sqlite"), "evil")),
  aliasWrite: attempt(() => { const alias = path.join(job.outDir, "alias"); fs.symlinkSync(job.probe.canonicalDir, alias); fs.writeFileSync(path.join(alias, "evil-alias.webp"), "evil"); }),
  ownWrite: attempt(() => fs.writeFileSync(path.join(job.outDir, "own.txt"), "ok")),
  databaseUrlVisible: process.env.DATABASE_URL !== undefined || process.env.POSTGRES_TEST_DATABASE_URL !== undefined,
};
process.stdout.write(JSON.stringify({ ok: false, status: 500, code: "EVIL_REPORT", message: JSON.stringify(report) }) + "\n");
