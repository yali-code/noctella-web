// Stage 5 F2 (#472) release packaging: builds the REVIEWED Landlock launcher
// (scripts/photo-publication-capability/landlock-worker.c) for the protected-mode preparation workers.
//
//   node scripts/build-landlock-launcher.mjs [--out <dir>]        (from apps/api; default out: apps/api/dist/bin)
//
// Output: <out>/landlock-worker (0755) and <out>/landlock-worker.provenance.json (source/binary sha256, sizes, arch,
// compiler, flags). No sudo, no installs, no permission changes outside <out>. Linux only; fails with a non-zero exit and
// a LAUNCHER_BUILD_FAILED line when the platform, compiler, kernel headers or compilation are missing. There is no
// fallback: protected mode stays NOT READY without an executable launcher. Hashes are recorded, not assumed to be
// identical across different build hosts or compilers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCHER_FLAGS = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"];
const here = path.dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_SOURCE = path.resolve(here, "..", "..", "..", "scripts", "photo-publication-capability", "landlock-worker.c");
export const DEFAULT_OUT = path.resolve(here, "..", "dist", "bin");
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

class BuildError extends Error {}
const fail = (reason) => { throw new BuildError(reason); };

function compiler(env) {
  for (const candidate of [env.CC, "cc", "gcc", "clang"].filter(Boolean)) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return { command: candidate, version: probe.stdout.split("\n")[0].trim() };
  }
  return null;
}

export function buildLandlockLauncher({ out = DEFAULT_OUT, env = process.env } = {}) {
  if (process.platform !== "linux") fail(`unsupported platform ${process.platform} (Landlock launcher is Linux-only)`);
  if (!fs.existsSync(LAUNCHER_SOURCE)) fail(`reviewed source missing: ${LAUNCHER_SOURCE}`);
  const cc = compiler(env);
  if (!cc) fail("no C compiler (CC, cc, gcc or clang) on PATH");
  const header = spawnSync(cc.command, ["-x", "c", "-fsyntax-only", "-"], { input: "#include <linux/landlock.h>\nint main(void){return 0;}\n", encoding: "utf8" });
  if (header.status !== 0) fail("kernel UAPI header linux/landlock.h unavailable");
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, "landlock-worker"), staged = path.join(out, `.landlock-worker.${process.pid}.tmp`);
  fs.rmSync(staged, { force: true });
  const compile = spawnSync(cc.command, [...LAUNCHER_FLAGS, LAUNCHER_SOURCE, "-o", staged], { encoding: "utf8" });
  if (compile.status !== 0) { fs.rmSync(staged, { force: true }); fail(`compilation failed: ${(compile.stderr || compile.stdout || "").trim().split("\n").slice(0, 5).join(" | ")}`); }
  const magic = fs.readFileSync(staged).subarray(0, 4);
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) { fs.rmSync(staged, { force: true }); fail("compiler output is not an ELF executable"); }
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, target); // atomic replacement inside <out>
  const uname = spawnSync("uname", ["-m"], { encoding: "utf8" });
  const provenance = {
    schema: 1,
    source: { path: "scripts/photo-publication-capability/landlock-worker.c", sha256: sha256(LAUNCHER_SOURCE), bytes: fs.statSync(LAUNCHER_SOURCE).size },
    binary: { file: "landlock-worker", sha256: sha256(target), bytes: fs.statSync(target).size },
    platform: { os: process.platform, arch: process.arch, machine: (uname.stdout || "").trim() },
    compiler: { command: cc.command, version: cc.version, flags: LAUNCHER_FLAGS },
  };
  fs.writeFileSync(path.join(out, "landlock-worker.provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  return { target, provenance };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? path.resolve(process.argv[i + 1] ?? "") : DEFAULT_OUT;
  try {
    const { target, provenance } = buildLandlockLauncher({ out });
    console.log(`LAUNCHER_BUILT ${target}`);
    console.log(`LAUNCHER_SOURCE_SHA256 ${provenance.source.sha256}`);
    console.log(`LAUNCHER_BINARY_SHA256 ${provenance.binary.sha256}`);
    console.log(`LAUNCHER_PLATFORM ${provenance.platform.os}/${provenance.platform.machine} ${provenance.compiler.version}`);
  } catch (error) {
    console.error(`LAUNCHER_BUILD_FAILED ${error instanceof BuildError ? error.message : String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}
