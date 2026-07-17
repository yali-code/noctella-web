import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { copyBuildAsset } from "../scripts/copy-build-asset.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(apiRoot, "scripts", "copy-build-asset.mjs");

test("copies unchanged content, creates directories, replaces destinations, and supports spaces", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "api build copy with spaces "));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const source = path.join(fixtureRoot, "source assets", "schema.sql");
  const destination = path.join(fixtureRoot, "build output", "db", "schema.sql");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "CREATE TABLE copied (id TEXT);\n");

  await copyBuildAsset(source, destination);
  assert.equal(await readFile(destination, "utf8"), "CREATE TABLE copied (id TEXT);\n");

  await writeFile(source, "CREATE TABLE replaced (id TEXT);\n");
  await copyBuildAsset(source, destination);
  assert.equal(await readFile(destination, "utf8"), "CREATE TABLE replaced (id TEXT);\n");
});

test("missing required source fails clearly", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "api-build-copy-missing-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const source = path.join(fixtureRoot, "missing.sql");
  const destination = path.join(fixtureRoot, "dist", "schema.sql");
  const result = spawnSync(process.execPath, [helperPath, source, destination], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to copy required build asset/);
  assert.match(result.stderr, /ENOENT/);
});

test("build path contains no platform-specific copy command", async () => {
  const packageJson = await readFile(path.join(apiRoot, "package.json"), "utf8");
  const helper = await readFile(helperPath, "utf8");
  const implementation = `${packageJson}\n${helper}`;

  assert.doesNotMatch(implementation, /(?:^|[;&|]\s*|&&\s*)cp(?:\s|$)/m);
  assert.doesNotMatch(implementation, /\b(?:Copy-Item|xcopy|robocopy)\b/i);
});
