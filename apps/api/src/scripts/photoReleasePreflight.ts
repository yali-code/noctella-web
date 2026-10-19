/**
 * FAZ A #424 package G: READ-ONLY photo release preflight for a staging candidate. It inspects configuration, the
 * PostgreSQL migration inventory and storage roots; it never creates, writes or deletes anything and never connects
 * to a database. Usage: `npm run photos:release-preflight -w apps/api` (JSON; exit 1 on any FAIL).
 */
import fs from "node:fs";
import path from "node:path";
import { photoOwnershipFencingConfig } from "../services/photoOwnershipFencing";
import { aiIntakeOriginalSourceStagingConfig } from "../services/aiIntakeOriginalSourceStaging";
import { crossProcessExitAuthenticationAvailable } from "../services/photoPublicationExecutor";
import { photoPreparationConfinementConfig } from "../services/photoPreparationConfinement";
import { createHash } from "node:crypto";

export type PreflightStatus = "PASS" | "WARN" | "FAIL" | "MANUAL";
export interface PreflightCheck { id: string; status: PreflightStatus; detail: string }
export const PREFLIGHT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

export function runPhotoReleasePreflight(options: { env?: NodeJS.ProcessEnv; migrationsDir?: string; canonicalRoot?: string; statfs?: (dir: string) => { bavail: number; bsize: number } } = {}) {
  const env = options.env ?? process.env;
  const migrationsDir = options.migrationsDir ?? path.resolve(__dirname, "../db/postgres-migrations");
  const canonicalRoot = path.resolve(options.canonicalRoot ?? env.PRODUCT_PHOTO_DIR ?? path.resolve(process.cwd(), "uploads/product-photos"));
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string) => checks.push({ id, status, detail });

  // Flags: invalid values must be visible before any deploy.
  const fencing = photoOwnershipFencingConfig(env);
  add("flag.fencing", fencing.valid ? "PASS" : "FAIL", fencing.valid ? `PHOTO_OWNERSHIP_FENCING_ENABLED is ${fencing.enabled ? "ON" : "OFF"}` : `invalid PHOTO_OWNERSHIP_FENCING_ENABLED value (treated as ON): ${JSON.stringify(fencing.raw)}`);
  const confinement = photoPreparationConfinementConfig(env);
  // Protected mode requires confined preparation (#472). With fencing OFF the setting is not used yet: WARN, not FAIL,
  // unless the value itself is malformed.
  const malformed = confinement.mode === "invalid" && env.PHOTO_PREPARATION_CONFINEMENT !== undefined && env.PHOTO_PREPARATION_CONFINEMENT !== "" && env.PHOTO_PREPARATION_CONFINEMENT !== "required";
  add("flag.preparation-confinement", confinement.mode === "confined" ? "PASS" : confinement.mode === "invalid" && (fencing.enabled || malformed) ? "FAIL" : "WARN",
    confinement.mode === "confined" ? `image preparation runs in Landlock-confined workers (${confinement.launcher})`
      : confinement.mode === "invalid" ? `${confinement.reason}${fencing.enabled ? " (protected publication refuses: NOT READY)" : " (required before fencing is turned ON)"}`
        : "UNPROTECTED in-process preparation (test/development only): a hostile preparer is not isolated");
  if (confinement.mode === "confined") {
    // The configured launcher must be the packaged build of the reviewed source (build-landlock-launcher.mjs).
    const provenanceFile = path.join(path.dirname(confinement.launcher), "landlock-worker.provenance.json");
    const sourceFile = path.resolve(__dirname, "../../../../scripts/photo-publication-capability/landlock-worker.c");
    const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    try {
      const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
      const binaryOk = provenance?.binary?.sha256 === digest(confinement.launcher);
      const sourceOk = !fs.existsSync(sourceFile) || provenance?.source?.sha256 === digest(sourceFile);
      add("launcher.provenance", binaryOk && sourceOk ? "PASS" : "FAIL", binaryOk && sourceOk
        ? `launcher binary sha256 ${provenance.binary.sha256} built from source ${provenance.source.sha256} (${provenance.compiler?.version ?? "compiler unknown"})`
        : !binaryOk ? "launcher binary does not match its provenance record" : "launcher was not built from the reviewed source in this checkout");
    } catch { add("launcher.provenance", "FAIL", `provenance record missing or unreadable next to ${confinement.launcher}`); }
  }
  const original = aiIntakeOriginalSourceStagingConfig(env);
  add("flag.w3-original-source", original.valid ? (original.requested && !original.activatable ? "WARN" : "PASS") : "FAIL",
    !original.valid ? "invalid AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED value" : original.requested && !original.activatable ? "requested but not activatable outside test/development (owner retention decision pending)" : `original-source staging ${original.enabled ? "ON" : "OFF"}`);

  // Migration inventory (no ledger: numbers must be unique; gaps and the W11 proposal are surfaced explicitly).
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  const numbers = files.map((file) => file.slice(0, 4));
  const duplicates = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
  add("migrations.unique-numbers", duplicates.length ? "FAIL" : "PASS", duplicates.length ? `duplicate migration numbers: ${duplicates.join(", ")}` : `${files.length} uniquely numbered migrations`);
  // 0043/0044: protected publication (#472). Fencing ON refuses W2/W4 without them (fail closed), so they are required.
  for (const required of ["0040_photo_operation_ownership.sql", "0041_photo_w2_upload_intents.sql", "0043_photo_publication_intents.sql", "0044_photo_publication_copies.sql"])
    add(`migrations.${required.slice(0, 4)}`, files.includes(required) ? "PASS" : "FAIL", files.includes(required) ? `${required} present` : `${required} missing`);
  const max = Math.max(...numbers.map(Number));
  const gaps = Array.from({ length: max }, (_, i) => String(i + 1).padStart(4, "0")).filter((n) => !numbers.includes(n));
  add("migrations.gaps", gaps.length ? "WARN" : "PASS", gaps.length ? `numbers not present on this candidate: ${gaps.join(", ")}${gaps.includes("0039") ? " (0039 is the released Etsy migration; the release candidate must include it)" : ""}${gaps.includes("0042") ? " (0042 is reserved for the unapproved W11 proposal)" : ""}` : "no gaps");
  const w11 = files.filter((file) => file.startsWith("0042"));
  add("migrations.0042-w11", w11.length === 0 ? "PASS" : w11.length === 1 && w11[0] === "0042_photo_derivative_operations.sql" ? "WARN" : "FAIL",
    w11.length === 0 ? "W11 0042 not registered (proposal only; owner approval pending)" : w11.length === 1 && w11[0] === "0042_photo_derivative_operations.sql" ? "W11 0042 registered: requires recorded owner approval" : `unexpected 0042 migration(s): ${w11.join(", ")}`);

  // Storage roots: link() publication requires one filesystem; nothing is created here.
  const parent = path.dirname(canonicalRoot);
  const device = (dir: string) => { try { return fs.statSync(dir).dev; } catch { return undefined; } };
  const parentDevice = device(parent);
  add("storage.canonical-root", device(canonicalRoot) !== undefined ? "PASS" : "WARN", device(canonicalRoot) !== undefined ? `canonical root exists: ${canonicalRoot}` : `canonical root does not exist yet: ${canonicalRoot}`);
  for (const [id, dir] of [["storage.private-operations", path.join(parent, ".product-photo-operations")], ["storage.publication-staging", path.join(parent, ".product-photo-publication")], ["storage.upload-staging", path.join(parent, ".product-photo-upload-staging")]] as const) {
    const dev = device(dir);
    if (dev === undefined) add(id, parentDevice === undefined ? "FAIL" : "PASS", parentDevice === undefined ? `parent of the canonical root is missing: ${parent}` : `${dir} will be created under the canonical parent (same filesystem)`);
    else add(id, dev === parentDevice ? "PASS" : "FAIL", dev === parentDevice ? `${dir} is on the canonical filesystem` : `${dir} is on a different filesystem: hard-link publication would fail closed`);
  }
  try {
    const stats = (options.statfs ?? ((dir) => fs.statfsSync(dir)))(parentDevice === undefined ? process.cwd() : parent);
    const free = stats.bavail * stats.bsize;
    add("storage.free-space", free >= PREFLIGHT_MIN_FREE_BYTES ? "PASS" : "WARN", `${Math.floor(free / 1048576)} MiB available (warn below ${PREFLIGHT_MIN_FREE_BYTES / 1048576} MiB)`);
  } catch { add("storage.free-space", "WARN", "free space could not be measured"); }

  // Executor-loss recovery (#472): without Linux /proc the runtime cannot prove a terminated executor; such intents stay BLOCKED.
  add("publication.exit-authentication", crossProcessExitAuthenticationAvailable() ? "PASS" : "WARN", crossProcessExitAuthenticationAvailable()
    ? "same-instance executor termination is provable (Linux /proc, boot id, PID namespace)"
    : "this platform cannot prove executor termination: intents of a lost executor stay BLOCKED until operator attestation");

  // Platform facts that offline code cannot verify.
  add("render.single-instance-drain", "MANUAL", "confirm in Render that the old instance stopped before the new one started and no worker/cron can reach PRODUCT_PHOTO_DIR");
  add("publication.restart-attestation", "MANUAL", "after any deploy or instance replacement run photos:publication-intents; authorized intents of the previous instance stay BLOCKED until an operator verifies its termination and attests (--attest-exit)");
  add("backups", "MANUAL", "run db:backup, photos:backup and db:restore-verify before deploying; record hashes");

  const status: PreflightStatus = checks.some((c) => c.status === "FAIL") ? "FAIL" : checks.some((c) => c.status === "WARN" || c.status === "MANUAL") ? "WARN" : "PASS";
  return { generatedAt: new Date().toISOString(), readOnly: true, status, checks };
}

if (require.main === module) {
  const result = runPhotoReleasePreflight();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "FAIL" ? 1 : 0;
}
