import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_BYTES, TARGET_BYTES, scenarios, parseEvents, parseProcStatus, validateLimits, assess } from "./policy.mjs";
const limits = () => ({ max: HARD_BYTES, swapMax: 0, current: 80e6, peak: 150e6, events: { max: 0, oom: 0, oom_kill: 0 } });
const evidence = () => ({ before: limits(), after: limits(), result: { scenario: { ops: 1 }, operations: [{ asExpected: true }], leftovers: { photoDirFiles: 2, expectedPhotoDirFiles: 2, tmpDirFiles: [] } }, exitCode: 0, timedOut: false, diskStopped: false, oomKilled: false, cleanup: true });
test("bounded profile covers each format at 1/2/4, sequential twelve, invalid and stress last", () => {
  const all = scenarios();
  assert.equal(all.length, 12);
  assert.equal(new Set(all.map(s => s.name)).size, 12);
  for (const format of ["jpeg", "png", "webp"]) assert.deepEqual(all.filter(s => s.name.startsWith("linux-" + format)).map(s => s.concurrency), [1, 2, 4]);
  assert.equal(all.find(s => s.name === "linux-sequential-12").ops, 12);
  assert.equal(all.at(-1).name, "linux-stress-144mp-c4");
  assert.equal(scenarios(false).length, 11);
});
test("limits must be exactly 512 MiB, no swap, cgroup counters and loopback-only", () => {
  validateLimits(limits(), ["lo"]);
  for (const snapshot of [{ ...limits(), max: Infinity }, { ...limits(), max: HARD_BYTES * 2 }, { ...limits(), swapMax: 1 }, { ...limits(), peak: NaN }, { ...limits(), events: {} }]) assert.throws(() => validateLimits(snapshot, ["lo"]));
  assert.throws(() => validateLimits(limits(), ["lo", "eth0"]));
});
test("event parser rejects malformed counters", () => {
  assert.deepEqual(parseEvents("max 2\noom 1\noom_kill 1\n"), { max: 2, oom: 1, oom_kill: 1 });
  assert.throws(() => parseEvents("oom unknown"));
});
test("only complete target-compliant evidence passes; boundary inclusive", () => {
  const e = evidence(); e.after.peak = TARGET_BYTES;
  assert.equal(assess(e).status, "PASS");
  e.after.peak++; assert.equal(assess(e).status, "FAIL");
});
test("OOM and nonzero exits are never green even with a worker result", () => {
  for (const override of [{ exitCode: 137 }, { oomKilled: true }, { timedOut: true }, { diskStopped: true }, { cleanup: false }]) assert.equal(assess({ ...evidence(), ...override }).status, "FAIL");
  for (const key of ["oom", "oom_kill", "max"]) {
    const e = evidence(); e.after.events[key]++;
    assert.equal(assess(e).status, "FAIL");
  }
});
test("lost or reset cgroup evidence is inconclusive; lost worker result is fail", () => {
  assert.equal(assess({ ...evidence(), after: null }).status, "INCONCLUSIVE");
  const e = evidence(); e.before.events.max = 1; assert.equal(assess(e).status, "INCONCLUSIVE");
  assert.equal(assess({ ...evidence(), result: null }).status, "FAIL");
});
test("unexpected failures and partial outputs fail", () => {
  const e = evidence(); e.result.operations[0].asExpected = false;
  assert.equal(assess(e).status, "FAIL");
  e.result.operations[0].asExpected = true; e.result.leftovers.tmpDirFiles.push("partial");
  assert.equal(assess(e).status, "FAIL");
});

test("process RSS and HWM use kernel KiB; changed limits cannot pass", () => {
  assert.deepEqual(parseProcStatus("Name:\tnode\nVmRSS:\t2048 kB\nVmHWM:\t4096 kB\n"), { name: "node", rss: 2097152, hwm: 4194304 });
  const e = evidence(); e.after.max *= 2; assert.equal(assess(e).status, "INCONCLUSIVE");
});
test("retry profile selects only four failed c4 cases and rejects unbounded profiles", async () => {
  const { selectedScenarios } = await import("./policy.mjs");
  assert.equal(selectedScenarios(true, "full").length, 12);
  assert.equal(selectedScenarios(true, "c4").length, 4);
  assert.ok(selectedScenarios(true, "c4").every(s => s.concurrency === 4));
  assert.throws(() => selectedScenarios(true, "unknown"));
});
