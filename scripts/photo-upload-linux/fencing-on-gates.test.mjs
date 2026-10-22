// FAZ A #424: fencing-ON 24MP acceptance gates that hold BEFORE W11/0042 approval. A fencing-ON run can never be
// labelled PASS while W11 is unadopted, and its operation evidence is validated exactly once it can run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_BYTES, assess, selectedScenarios, validateFencingOnEvidence, FENCING_ON_ACCEPTANCE, FENCING_ON_OPERATION_CONTRACT } from "./policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const limits = () => ({ max: HARD_BYTES, swapMax: 0, current: 80e6, peak: 150e6, events: { max: 0, oom: 0, oom_kill: 0 } });
const goodOperations = () => ({ operations: [...Array(3)].map(() => ({ kind: "product_upload", state: "committed" })).concat([{ kind: "ai_finalize", state: "committed" }]), derivativeOperations: null });
const passingItem = (scenario) => ({
  scenario, before: limits(), after: limits(), exitCode: 0, timedOut: false, diskStopped: false, oomKilled: false, cleanup: true,
  result: { scenario, operations: [...Array(8)].map(() => ({ asExpected: true })), leftovers: { photoDirFiles: 9, expectedPhotoDirFiles: 9, tmpDirFiles: [] }, fencingOperations: goodOperations() },
});

test("W11 is unadopted: the fencing-ON acceptance stays blocked", () => {
  assert.equal(FENCING_ON_ACCEPTANCE.blocked, true);
  assert.deepEqual({ ...FENCING_ON_OPERATION_CONTRACT }, { product_upload: 3, ai_finalize: 1, instagram_derivative: 1 });
});

test("a flawless fencing-ON case is BLOCKED, never PASS; the same evidence fencing-OFF still passes", () => {
  const [on] = selectedScenarios(true, "combined-fencing-on"), [off] = selectedScenarios(true, "combined-original-source");
  assert.equal(assess(passingItem(on)).status, "BLOCKED");
  assert.match(assess(passingItem(on)).reason, /W11/);
  assert.equal(assess({ ...passingItem(on), scenario: undefined }).status, "BLOCKED", "the result's scenario alone also blocks");
  const offItem = passingItem(off); delete offItem.result.fencingOperations;
  assert.equal(assess(offItem).status, "PASS");
});

test("fencing-ON operation evidence is validated exactly (before W11 adoption)", () => {
  assert.deepEqual(validateFencingOnEvidence(goodOperations(), { w11Adopted: false }), { ok: true, problems: [] });
  const mutate = (change) => { const e = goodOperations(); change(e); return validateFencingOnEvidence(e, { w11Adopted: false }); };
  assert.equal(validateFencingOnEvidence(undefined).ok, false);
  assert.equal(mutate((e) => { e.derivativeOperations = [{ state: "committed" }]; }).ok, false, "W11 evidence cannot appear while unadopted");
  assert.equal(mutate((e) => e.operations.push({ kind: "product_upload", state: "committed" })).ok, false, "exact W2 count");
  assert.equal(mutate((e) => e.operations.pop()).ok, false, "W4 photo missing");
  for (const state of ["preparing", "sealed", "review"]) assert.equal(mutate((e) => { e.operations[0].state = state; }).ok, false, "lost ownership / unfinished: " + state);
  assert.equal(mutate((e) => e.operations.push({ kind: "legacy_writer", state: "committed" })).ok, false, "unexpected kind");
});

test("fencing-ON operation evidence after W11 adoption requires exactly one committed derivative", () => {
  const adopted = (derivativeOperations) => validateFencingOnEvidence({ ...goodOperations(), derivativeOperations }, { w11Adopted: true });
  assert.equal(adopted([{ state: "committed" }]).ok, true);
  assert.equal(adopted(null).ok, false);
  assert.equal(adopted([]).ok, false);
  assert.equal(adopted([{ state: "committed" }, { state: "committed" }]).ok, false);
  assert.equal(adopted([{ state: "sealed" }]).ok, false);
});

test("CI: the fencing-ON profile is never in the measured Linux matrix while blocked; BLOCKED dry runs stay enforced", () => {
  const workflow = readFileSync(path.join(repo, ".github/workflows/photo-master-stage1-4.yml"), "utf8");
  const matrix = workflow.split(/^  linux-512m-24mp-combined:\s*$/m)[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0] ?? "";
  assert.ok(matrix.length > 0, "Linux matrix job present");
  assert.doesNotMatch(matrix, /combined-fencing-on/, "no measured fencing-ON trials while W11 is unadopted");
  assert.match(workflow, /CASE_PROFILE=combined-fencing-on node scripts\/photo-upload-linux\/run-host\.mjs/);
  assert.match(workflow, /node --test scripts\/photo-upload-linux\/fencing-blocked\.test\.mjs/);
  assert.match(workflow, /node --test [^\n]*scripts\/photo-upload-linux\/fencing-on-gates\.test\.mjs/);
});

test("probe only records fencing-ON evidence: it never writes ownership tables or simulates W11", () => {
  const probe = readFileSync(path.join(repo, "apps/api/src/scripts/sharedImageResourceProbe.ts"), "utf8");
  const block = probe.slice(probe.indexOf("FAZ A fencing-ON evidence"), probe.indexOf("const privateFiles="));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/i);
  assert.doesNotMatch(probe, /photo_derivative_operations[^\n]*(INSERT|CREATE)/i);
  assert.match(probe, /Object\.assign\(process\.env,\{ NODE_ENV: "test", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" \}\)/);
});
