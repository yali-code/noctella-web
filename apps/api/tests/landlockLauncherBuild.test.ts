/**
 * Stage 5 F2 closure Stage 1: the repository-owned launcher build entry point (scripts/build-landlock-launcher.mjs) and
 * the preflight provenance check of the configured launcher. Linux cases run in the required gate.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runPhotoReleasePreflight } from "../src/scripts/photoReleasePreflight";

const script = path.join(__dirname, "..", "scripts", "build-landlock-launcher.mjs");
const REVIEWED_SOURCE_SHA256 = "2e5deabf2848fd53bc57130afd5ed1caf060961bfac28bc2be71568892d01a55";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-launcher-build-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
const linux = process.platform === "linux";
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const build = (out: string, env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [script, "--out", out], { encoding: "utf8", env });

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required Linux execution of the launcher build suite", () => { expect(linux).toBe(true); });

it("the candidate launcher source matches its pinned fingerprint (independent review remains pending)", () => {
  const source = path.join(__dirname, "..", "..", "..", "scripts", "photo-publication-capability", "landlock-worker.c");
  expect(createHash("sha256").update(fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n")).digest("hex")).toBe(REVIEWED_SOURCE_SHA256);
});

it.runIf(!linux)("refuses to build off Linux with a clear failure (no fallback binary)", () => {
  const out = path.join(root, "non-linux");
  const r = build(out);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^LAUNCHER_BUILD_FAILED unsupported platform /m);
  expect(fs.existsSync(path.join(out, "landlock-worker"))).toBe(false);
});

describe.runIf(linux)("Linux build", () => {
  it("builds with -std=c11 -Wall -Wextra -Werror -O2 and records source/binary provenance", () => {
    const out = path.join(root, "bin");
    const r = build(out);
    expect(r.status, r.stderr).toBe(0);
    const binary = path.join(out, "landlock-worker"), provenance = JSON.parse(fs.readFileSync(path.join(out, "landlock-worker.provenance.json"), "utf8"));
    expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(binary).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(provenance).toMatchObject({ schema: 1, source: { sha256: REVIEWED_SOURCE_SHA256 }, binary: { sha256: sha(binary), bytes: fs.statSync(binary).size }, platform: { os: "linux" },
      compiler: { flags: ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"] } });
    expect(r.stdout).toContain(`LAUNCHER_BINARY_SHA256 ${provenance.binary.sha256}`);
    expect(fs.readdirSync(out).sort()).toEqual(["landlock-worker", "landlock-worker.provenance.json"]); // no temporaries left
    // The launcher refuses an untrusted descriptor layout (plain terminal pipes are not its contract).
    const refused = spawnSync(binary, [out, "--", "/bin/true"], { stdio: ["pipe", "pipe", "pipe"] });
    expect(refused.status).toBe(125);
  });

  it("fails clearly without a compiler (no binary, no provenance)", () => {
    const out = path.join(root, "no-cc");
    const r = build(out, { PATH: path.join(root, "empty-path"), CC: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^LAUNCHER_BUILD_FAILED no C compiler/m);
    expect(fs.existsSync(path.join(out, "landlock-worker"))).toBe(false);
  });

  it("preflight: the configured launcher passes only when it matches its provenance and the reviewed source", () => {
    const out = path.join(root, "preflight");
    expect(build(out).status).toBe(0);
    const env = { PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: path.join(out, "landlock-worker") };
    const canonicalRoot = path.join(root, "photos"); fs.mkdirSync(canonicalRoot, { recursive: true });
    const check = () => runPhotoReleasePreflight({ env, canonicalRoot }).checks.find((c) => c.id === "launcher.provenance")!;
    expect(check()).toMatchObject({ status: "PASS" });
    // Simulate an incomplete deployed checkout without moving/deleting the real reviewed source.
    const source = path.resolve(__dirname, "../../../scripts/photo-publication-capability/landlock-worker.c");
    const exists = fs.existsSync;
    const missing = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) === source ? false : exists(file));
    try {
      expect(check()).toMatchObject({ status: "FAIL", detail: "reviewed launcher source is missing from this checkout" });
    } finally { missing.mockRestore(); }
    const record = path.join(out, "landlock-worker.provenance.json");
    const original = fs.readFileSync(record, "utf8");
    const mismatched = JSON.parse(original); mismatched.source.sha256 = "0".repeat(64);
    fs.writeFileSync(record, JSON.stringify(mismatched));
    expect(check()).toMatchObject({ status: "FAIL", detail: "launcher was not built from the reviewed source in this checkout" });
    fs.writeFileSync(record, original);
    fs.appendFileSync(path.join(out, "landlock-worker"), Buffer.from([0]));
    expect(check()).toMatchObject({ status: "FAIL", detail: "launcher binary does not match its provenance record" });
    fs.rmSync(path.join(out, "landlock-worker.provenance.json"));
    expect(check().status).toBe("FAIL");
  });
});
