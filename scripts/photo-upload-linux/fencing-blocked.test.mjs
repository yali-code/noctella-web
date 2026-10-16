import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("fencing-ON readiness records BLOCKED without Docker, spawning images, or fake memory cases", async () => {
  if (process.platform !== "linux") return;
  const dir = await mkdtemp(path.join(tmpdir(), "noctella-fon-blocked-"));
  try {
    const fixtures = path.join(dir, "fixtures"), out = path.join(dir, "evidence");
    await mkdir(fixtures);
    await writeFile(path.join(fixtures, "fixtures.json"), "[]\n");
    const script = fileURLToPath(new URL("./run-host.mjs", import.meta.url));
    // Do not inherit a docker executable: a blocked profile must not use one.
    const result = spawnSync(process.execPath, [script, out, fixtures], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PATH: "/nonexistent", CASE_PROFILE: "combined-fencing-on", INCLUDE_STRESS: "false" },
    });
    assert.equal(result.status, 3, result.stderr);
    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    assert.equal(summary.status, "BLOCKED");
    assert.match(summary.blockedReason, /W11/);
    assert.deepEqual(summary.cases, []);
    assert.equal(summary.host, undefined, "a dry run must not claim Docker or cgroup measurement");
    assert.equal(summary.fixtures, undefined, "a blocked dry run reads no fixtures (PR #448 contract)");
    assert.equal(summary.fatal, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
