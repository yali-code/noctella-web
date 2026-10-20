export const SOURCE_SHA = "7c6ab55237e996fef041c60bb06f45b7d0fc2061";
export const HARD_BYTES = 512 * 1024 * 1024;
export const TARGET_BYTES = 384 * 1024 * 1024;
export const SCENARIO_TIMEOUT_MS = 120_000;
export const DISK_STOP_BYTES = 256 * 1024 * 1024;
export const FIXTURES = ["jpeg-typical-landscape", "jpeg-near-limit", "png-near-limit", "webp-near-limit", "invalid-random-bytes", "png-stress-144mp"];

export function scenarios(includeStress = true) {
  const normal = ["jpeg", "png", "webp"].flatMap((format) =>
    [1, 2, 4].map((concurrency) => ({
      name: "linux-" + format + "-c" + concurrency,
      description: "Candidate product HTTP pipeline; four near-limit " + format + " operations",
      fixtures: [format + "-near-limit"], ops: 4, concurrency, path: "upload",
    })));
  normal.push({
    name: "linux-sequential-12", description: "Twelve sequential near-limit mixed transforms",
    fixtures: ["jpeg-typical-landscape", "jpeg-near-limit", "png-near-limit", "webp-near-limit"], ops: 12, concurrency: 1, path: "upload",
  }, {
    name: "linux-invalid", description: "Synthetic random bytes must be rejected",
    fixtures: ["invalid-random-bytes"], ops: 1, concurrency: 1, path: "upload",
  });
  if (includeStress) normal.push({
    name: "linux-stress-144mp-c4", description: "Last, explicitly bounded OOM-risk stress case",
    fixtures: ["png-stress-144mp"], ops: 4, concurrency: 4, path: "upload",
  });
  return normal;
}

export function parseEvents(text) {
  const result = {};
  for (const line of text.trim().split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (!key || !/^\d+$/.test(value ?? "")) throw new Error("Malformed cgroup events");
    result[key] = Number(value);
  }
  return result;
}

export function validateLimits(snapshot, networkNames) {
  if (snapshot.max !== HARD_BYTES || snapshot.swapMax !== 0) throw new Error("INCONCLUSIVE: 512-MiB/no-swap cgroup v2 limits not enforced");
  if (!Number.isFinite(snapshot.peak) || !Number.isFinite(snapshot.current)) throw new Error("INCONCLUSIVE: cgroup peak/current unavailable");
  for (const key of ["max", "oom", "oom_kill"]) {
    if (!Number.isSafeInteger(snapshot.events[key])) throw new Error("INCONCLUSIVE: cgroup events unavailable");
  }
  if (networkNames.some((name) => name !== "lo")) throw new Error("INCONCLUSIVE: non-loopback network interface");
}

export function parseProcStatus(text) {
  const value = (key) => Number(text.match(new RegExp("^" + key + ":\\s+(\\d+)\\s+kB", "m"))?.[1] ?? 0) * 1024;
  return { rss: value("VmRSS"), hwm: value("VmHWM"), name: text.match(/^Name:\s+(.+)$/m)?.[1] ?? "unknown" };
}

export function assess({ scenario, before, after, result, exitCode, timedOut, diskStopped, oomKilled, cleanup }) {
  // FAZ A: a fencing-ON case is BLOCKED while W11 is unadopted, whatever its other evidence says (never PASS).
  if ((scenario ?? result?.scenario)?.photoOwnershipFencing && FENCING_ON_ACCEPTANCE.blocked) return { status: "BLOCKED", reason: FENCING_ON_ACCEPTANCE.reason };
  if (!before || !after) return { status: "INCONCLUSIVE", reason: "Missing before/after cgroup evidence" };
  if ([before, after].some(s => s.max !== HARD_BYTES || s.swapMax !== 0 || !Number.isFinite(s.peak))) return { status: "INCONCLUSIVE", reason: "Limits changed or unavailable" };
  const delta = Object.fromEntries(Object.keys(after.events).map((key) => [key, after.events[key] - (before.events[key] ?? 0)]));
  if (Object.values(delta).some((n) => n < 0)) return { status: "INCONCLUSIVE", reason: "Cgroup counters reset", delta };
  if (timedOut || diskStopped || exitCode !== 0 || oomKilled || delta.oom > 0 || delta.oom_kill > 0 || delta.max > 0) {
    return { status: "FAIL", reason: "Exit/timeout/disk/memory-limit event", delta };
  }
  if (!result || result.operations.length !== result.scenario.ops || result.operations.some((op) => !op.asExpected)) {
    return { status: "FAIL", reason: "Missing or unexpected operations", delta };
  }
  if (!cleanup || result.leftovers.photoDirFiles !== result.leftovers.expectedPhotoDirFiles || result.leftovers.tmpDirFiles.length) {
    return { status: "FAIL", reason: "Cleanup/output-count mismatch", delta };
  }
  if (after.peak > TARGET_BYTES) return { status: "FAIL", reason: "Exceeded proposed 384-MiB cgroup peak target", delta };
  if ((scenario ?? result.scenario)?.photoOwnershipFencing) {
    const fencing = validateFencingOnEvidence(result.fencingOperations);
    if (!fencing.ok) return { status: "FAIL", reason: "Fencing-ON operation evidence mismatch: " + fencing.problems.join("; "), delta };
  }
  return { status: "PASS", reason: "HTTP smoke target satisfied; not final full-API acceptance", delta };
}

export function selectedScenarios(includeStress = true, profile = "full") {
  if (!["full", "c4", "webp-c4", "combined", "combined-reference", "combined-original-source", "combined-fencing-on"].includes(profile)) throw Error("Unknown bounded resource profile");
  // FAZ A: the unchanged 24MP mixed workload with REAL ownership fencing ON (W2 + W4 + W3 original-source; W11 once
  // adopted). Distinct names so fencing-OFF evidence can never be mistaken for it; blocked until W11 is adopted.
  if (profile === "combined-fencing-on") return [1, 2, 3].map(trial => ({ name: "linux-combined-fencing-on-t" + trial, description: "Combined workflows with PHOTO_OWNERSHIP_FENCING_ENABLED=true and the integrated original-source W3 writer", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial, aiIntakeOriginalSource: true, photoOwnershipFencing: true }));
  if (profile === "combined-reference") return [{ name: "linux-combined-reference-12mp", description: "DIAGNOSTIC ONLY: complete mixed workflow on a 12MP reference; cannot replace failed 24MP acceptance", fixtures: ["jpeg-typical-landscape"], ops: 8, concurrency: 3, path: "combined", trial: 1, acceptanceRole: "diagnostic-only" }];
  // #390 integrated acceptance: unchanged 24MP workload, real AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED writer, three fresh trials.
  if (profile === "combined-original-source") return [1, 2, 3].map(trial => ({ name: "linux-combined-original-source-t" + trial, description: "Combined workflows with the integrated original-source W3 writer (flag ON, NODE_ENV test)", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial, aiIntakeOriginalSource: true }));
  if (profile === "combined") return [1, 2, 3].map(trial => ({ name: "linux-combined-t" + trial, description: "Combined gated product, AI upload/finalization and Instagram synthetic workflows", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial }));
  return scenarios(includeStress).filter(s => profile === "full" || (profile === "c4" ? s.concurrency === 4 : s.name === "linux-webp-c4"));
}

/**
 * FAZ A fencing-ON acceptance readiness. The unchanged workload's instagram.prepare (W11) refuses under fencing until
 * W11 is adopted, which needs owner approval of the proposed 0042 schema. While blocked, run-host records BLOCKED
 * evidence for the fencing-ON profile instead of running it (and never substitutes fencing-OFF measurements).
 */
export const FENCING_ON_ACCEPTANCE = Object.freeze({
  blocked: true,
  // #472 parity 4B: instagram.prepare now succeeds under fencing through a separate non-canonical derivative store
  // instead of the W11/0042 owner this workload contract expects. That mapping changes the accepted workload and is
  // unreviewed; it stays BLOCKED until an independent review accepts the mapping (or W11/0042 is approved).
  reason: "Workload mapping reviewed (independent review PASS, #472 parity 4B): under PHOTO_OWNERSHIP_FENCING_ENABLED=true instagram.prepare uses the non-canonical derivative store, not the W11/0042 owner this contract expects. Still BLOCKED: clearing requires a reviewed change to this evidence contract and validateFencingOnEvidence (blocked=false currently implies W11 adoption and W11-table derivative evidence the separate store never produces), or owner approval of 0042",
});
export const fencingOnBlocked = (scenarios) => scenarios.some((s) => s.photoOwnershipFencing) && FENCING_ON_ACCEPTANCE.blocked;

/** Exact committed-operation contract of the unchanged fencing-ON 8-operation workload (3 W2 uploads, 1 W4 photo, 1 W11 derivative). */
export const FENCING_ON_OPERATION_CONTRACT = Object.freeze({ product_upload: 3, ai_finalize: 1, instagram_derivative: 1 });

/**
 * Validates the probe's fencing-ON operation evidence: { operations: [{ kind, state }] from photo_operations,
 * derivativeOperations: [{ state }] from the W11 table, or null when that table does not exist }.
 * Every operation must be committed (anything preparing/sealed/review means lost ownership or unfinished work), the
 * counts must match the contract exactly, and W11 evidence must be absent unless W11 is adopted.
 */
export function validateFencingOnEvidence(evidence, { w11Adopted = !FENCING_ON_ACCEPTANCE.blocked } = {}) {
  if (!evidence || !Array.isArray(evidence.operations)) return { ok: false, problems: ["missing fencing-ON operation evidence"] };
  const problems = [];
  if (!w11Adopted && evidence.derivativeOperations != null) problems.push("W11 derivative evidence present although W11 is not adopted");
  if (w11Adopted && !Array.isArray(evidence.derivativeOperations)) problems.push("W11 derivative evidence missing");
  const operations = [...evidence.operations, ...(evidence.derivativeOperations ?? []).map((o) => ({ kind: "instagram_derivative", state: o.state }))];
  for (const o of operations) {
    if (!Object.prototype.hasOwnProperty.call(FENCING_ON_OPERATION_CONTRACT, o.kind)) problems.push("unexpected operation kind " + o.kind);
    if (o.state !== "committed") problems.push(o.kind + " operation is " + o.state + " (ownership lost or work unfinished)");
  }
  const expected = { ...FENCING_ON_OPERATION_CONTRACT, instagram_derivative: w11Adopted ? 1 : 0 };
  for (const [kind, count] of Object.entries(expected)) {
    const found = operations.filter((o) => o.kind === kind && o.state === "committed").length;
    if (found !== count) problems.push(kind + ": expected " + count + " committed, found " + found);
  }
  return { ok: problems.length === 0, problems };
}
