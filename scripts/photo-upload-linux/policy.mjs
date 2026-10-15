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

export function assess({ before, after, result, exitCode, timedOut, diskStopped, oomKilled, cleanup }) {
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
  return { status: "PASS", reason: "HTTP smoke target satisfied; not final full-API acceptance", delta };
}

/** #390 DIAGNOSTIC allocator experiments: exact environment passed to the measured process; never acceptance. */
export const ALLOCATOR_EXPERIMENTS = {
  "glibc-mmap": { library: null, env: { MALLOC_MMAP_THRESHOLD_: "131072", MALLOC_TRIM_THRESHOLD_: "131072" } },
  "glibc-arena1-mmap": { library: null, env: { MALLOC_ARENA_MAX: "1", MALLOC_MMAP_THRESHOLD_: "131072", MALLOC_TRIM_THRESHOLD_: "131072" } },
  "jemalloc": { library: "jemalloc", env: { LD_PRELOAD: "/opt/alloc/libjemalloc.so" } },
  "jemalloc-decay0": { library: "jemalloc", env: { LD_PRELOAD: "/opt/alloc/libjemalloc.so", MALLOC_CONF: "dirty_decay_ms:0,muzzy_decay_ms:0,narenas:2" } },
  "mimalloc": { library: "mimalloc", env: { LD_PRELOAD: "/opt/alloc/libmimalloc.so" } },
  "mimalloc-purge0": { library: "mimalloc", env: { LD_PRELOAD: "/opt/alloc/libmimalloc.so", MIMALLOC_PURGE_DELAY: "0", MIMALLOC_ARENA_EAGER_COMMIT: "0" } },
};
export const allocatorEnvArgs = (name) => Object.entries(ALLOCATOR_EXPERIMENTS[name]?.env ?? {}).flatMap(([key, value]) => ["--env", key + "=" + value]);

/** #390 DIAGNOSTIC libvips builds: "prebuilt" is the unchanged npm binary; the others are injected by SONAME preload. */
export const LIBVIPS_VARIANTS = {
  prebuilt: { mapped: "/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3", preload: null },
  unmodified: { mapped: "/opt/vips-variants/unmodified/libvips-cpp.so.8.17.3", preload: "/opt/vips-variants/unmodified/libvips-cpp.so.8.17.3" },
  patched: { mapped: "/opt/vips-variants/patched/libvips-cpp.so.8.17.3", preload: "/opt/vips-variants/patched/libvips-cpp.so.8.17.3" },
};
export function diagnosticEnvArgs(scenario) {
  const env = { ...(ALLOCATOR_EXPERIMENTS[scenario.allocatorExperiment]?.env ?? {}) };
  const preload = LIBVIPS_VARIANTS[scenario.libvipsVariant]?.preload;
  if (preload) env.LD_PRELOAD = env.LD_PRELOAD ? preload + ":" + env.LD_PRELOAD : preload;
  return Object.entries(env).flatMap(([key, value]) => ["--env", key + "=" + value]);
}
const rgbFreeCase = (name, libvipsVariant, allocatorExperiment, extra = {}) => ({ name: "linux-rgbfree-" + name + "-24mp", description: "DIAGNOSTIC ONLY (#390): unchanged 24MP mixed workload with libvips " + libvipsVariant + (allocatorExperiment ? " + " + allocatorExperiment : " + default glibc") + "; not final acceptance", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial: 1, libvipsVariant, ...(allocatorExperiment ? { allocatorExperiment } : {}), parityGroup: "rgbfree", acceptanceRole: "diagnostic-only", ...extra });
const RGBFREE_REFERENCE = () => rgbFreeCase("reference-prebuilt-arena1", "prebuilt", "glibc-arena1-mmap", { parityReference: true });
/** #390 owner-authorized EXPERIMENT: original-source W3 staging; only the 2 staged sources and the W4 main+thumb may change. */
export const W3_ORIGINAL_ALLOWED_CHANGES = { "/work/intake": 2, "/work/photos": 2 };
export const FIDELITY_FIXTURES = ["jpeg-near-limit", "webp-near-limit", "png-near-limit", "jpeg-typical-landscape", "invalid-random-bytes", "png-stress-144mp"];
const w3OriginalCases = () => [
  { name: "linux-w3orig-reference-webp-first-arena1-24mp", description: "Parity reference only: live WebP-first W3 with prebuilt libvips + glibc arena1", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial: 1, libvipsVariant: "prebuilt", allocatorExperiment: "glibc-arena1-mmap", parityGroup: "w3orig", parityReference: true, acceptanceRole: "diagnostic-only" },
  ...[1, 2, 3].map(trial => ({ name: "linux-w3orig-original-source-t" + trial + "-24mp", description: "EXPERIMENT (#390): unchanged 24MP mixed workload with original-source W3 staging; npm libvips, default glibc, no overrides", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial, w3Staging: "original-source", parityGroup: "w3orig", parityAllowedChanges: W3_ORIGINAL_ALLOWED_CHANGES, acceptanceRole: "diagnostic-only" })),
];

export function selectedScenarios(includeStress = true, profile = "full") {
  if (!["full", "c4", "webp-c4", "combined", "combined-reference", "native-profile", "native-worker", "native-mmap", "native-allocators", "native-rgbfree", "native-rgbfree-trials", "native-rgbfree-alloc-trials", "w3-original-source"].includes(profile)) throw Error("Unknown bounded resource profile");
  if (profile === "w3-original-source") return w3OriginalCases();
  // Isolated native measurement first (default glibc), allocator combination only afterwards.
  if (profile === "native-rgbfree") return [RGBFREE_REFERENCE(), rgbFreeCase("unmodified", "unmodified"), rgbFreeCase("patched", "patched"), rgbFreeCase("unmodified-arena1", "unmodified", "glibc-arena1-mmap"), rgbFreeCase("patched-arena1", "patched", "glibc-arena1-mmap")];
  if (profile === "native-rgbfree-trials" || profile === "native-rgbfree-alloc-trials") return [RGBFREE_REFERENCE(), ...[1, 2, 3].map(trial => rgbFreeCase((profile === "native-rgbfree-trials" ? "patched" : "patched-arena1") + "-t" + trial, "patched", profile === "native-rgbfree-trials" ? undefined : "glibc-arena1-mmap", { trial }))];
  if (profile === "native-allocators") return Object.keys(ALLOCATOR_EXPERIMENTS).map(allocatorExperiment => ({ name: "linux-alloc-" + allocatorExperiment + "-24mp", description: "DIAGNOSTIC ONLY (#390): unchanged 24MP mixed workload under an allocator override; not final acceptance", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial: 1, allocatorExperiment, acceptanceRole: "diagnostic-only" }));
  if (profile === "native-worker" || profile === "native-mmap") return [{ name: "linux-"+profile+"-24mp", description: "DIAGNOSTIC ONLY: unchanged mixed workload with isolated AI recipe or glibc mmap policy; not final acceptance", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial: 1, recipeWorker: profile === "native-worker", mmapPolicy: profile === "native-mmap", acceptanceRole: "diagnostic-only" }];
  if (profile === "native-profile") return [{ name: "linux-native-profile-24mp", description: "DIAGNOSTIC ONLY: glibc large allocation stacks and lifetimes; instrumentation is not acceptance", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial: 1, nativeTrace: true, acceptanceRole: "diagnostic-only" }];
  if (profile === "combined-reference") return [{ name: "linux-combined-reference-12mp", description: "DIAGNOSTIC ONLY: complete mixed workflow on a 12MP reference; cannot replace failed 24MP acceptance", fixtures: ["jpeg-typical-landscape"], ops: 8, concurrency: 3, path: "combined", trial: 1, acceptanceRole: "diagnostic-only" }];
  if (profile === "combined") return [1, 2, 3].map(trial => ({ name: "linux-combined-t" + trial, description: "Combined gated product, AI upload/finalization and Instagram synthetic workflows", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 3, path: "combined", trial }));
  return scenarios(includeStress).filter(s => profile === "full" || (profile === "c4" ? s.concurrency === 4 : s.name === "linux-webp-c4"));
}

/** Byte parity per group against its reference: MATCH, MISMATCH (exact digest differences) or MISSING (no outputs, e.g. OOM). */
export function compareParity(cases) {
  const groups = {};
  for (const group of new Set(cases.filter(c => c.parityGroup).map(c => c.parityGroup))) {
    const members = cases.filter(c => c.parityGroup === group);
    const reference = members.find(c => c.parityReference && Array.isArray(c.digests));
    groups[group] = { reference: reference?.name ?? null, results: members.filter(c => !c.parityReference).map(c => {
      if (!reference || !Array.isArray(c.digests)) return { name: c.name, status: "MISSING" };
      const same = c.digests.length === reference.digests.length && c.digests.every((d, i) => d === reference.digests[i]);
      if (same) return { name: c.name, status: "MATCH" };
      const onlyInReference = reference.digests.filter(d => !c.digests.includes(d)), onlyInCase = c.digests.filter(d => !reference.digests.includes(d));
      const perDir = list => JSON.stringify(Object.entries(list.reduce((m, d) => { const dir = d.slice(0, d.lastIndexOf(":")); m[dir] = (m[dir] ?? 0) + 1; return m; }, {})).sort());
      // Declared experimental change: exactly the allowed number of changed files per directory on both sides, everything else identical.
      const expected = c.parityAllowedChanges && c.digests.length === reference.digests.length && perDir(onlyInReference) === perDir(onlyInCase) && perDir(onlyInCase) === JSON.stringify(Object.entries(c.parityAllowedChanges).sort());
      return { name: c.name, status: expected ? "EXPECTED_CHANGE" : "MISMATCH", onlyInReference, onlyInCase };
    }) };
  }
  return { ok: Object.values(groups).every(g => g.reference && g.results.every(r => r.status === "MATCH" || r.status === "EXPECTED_CHANGE")), groups };
}

/** Observer race only: a work-directory entry removed between listing and inspection (never permission, I/O or symlink errors). */
export const isVanishedEntryError = (error) => error?.code === "ENOENT";

export const COMBINED_INPUT_SHA='2f2f90eb7060b031815c5afc8503e2914b2e7eb398b29eabfd23330443c441c7';
export function validateCombinedMode(scenario,environment,fixture,actualSha){
 if(scenario.path!=='combined')return {role:'other-profile'};
 if(scenario.ops!==8||fixture.name!=='jpeg-near-limit'||fixture.width!==6000||fixture.height!==4000||fixture.sizeBytes!==9670997||actualSha!==COMBINED_INPUT_SHA) {
  if(scenario.acceptanceRole!=='diagnostic-only')throw Error('Original combined workload changed');
 }
 const role=scenario.acceptanceRole==='diagnostic-only'?'diagnostic-only':'acceptance';
 const allocator=Object.fromEntries(Object.entries(environment).filter(([name,value])=>value&&(name.startsWith('MALLOC_')||name.startsWith('MIMALLOC_')||name==='LD_PRELOAD'||name==='NOCTELLA_NATIVE_TRACE')));
 if(role==='acceptance'&&(scenario.nativeTrace||scenario.recipeWorker||scenario.mmapPolicy||scenario.allocatorExperiment||scenario.libvipsVariant||scenario.w3Staging||Object.keys(allocator).length))throw Error('Acceptance cannot use diagnostic overrides');
 return {role,nativeTrace:!!scenario.nativeTrace,recipeWorker:!!scenario.recipeWorker,mmapPolicy:!!scenario.mmapPolicy,allocatorExperiment:scenario.allocatorExperiment??null,libvipsVariant:scenario.libvipsVariant??null,w3Staging:scenario.w3Staging??null,allocator,actualSha,dimensions:[fixture.width,fixture.height],inputBytes:fixture.sizeBytes,ops:scenario.ops,recipe:{autoOrient:true,webpQuality:86,resize:false}};
}
