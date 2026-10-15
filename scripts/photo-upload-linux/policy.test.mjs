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
  assert.deepEqual(selectedScenarios(true, "webp-c4").map(s => s.name), ["linux-webp-c4"]);
  assert.throws(() => selectedScenarios(true, "unknown"));
});
test("combined profile has exactly three fresh 24MP synthetic trials with eight operations", async () => {
  const { selectedScenarios } = await import("./policy.mjs");
  const cases=selectedScenarios(true,"combined");
  assert.equal(cases.length,3);assert.deepEqual(cases.map(s=>s.trial),[1,2,3]);
  assert.ok(cases.every(s=>s.ops===8&&s.concurrency===3&&s.path==="combined"&&s.fixtures[0]==="jpeg-near-limit"));
});
test("smaller reference is explicitly diagnostic and never replaces combined acceptance", async()=>{
  const {selectedScenarios}=await import("./policy.mjs");const reference=selectedScenarios(true,"combined-reference");
  assert.equal(reference.length,1);assert.equal(reference[0].acceptanceRole,"diagnostic-only");
  assert.equal(reference[0].fixtures[0],"jpeg-typical-landscape");
  assert.equal(selectedScenarios(true,"combined").length,3);
});

test("native allocator diagnostics cannot masquerade as uninstrumented final acceptance",async()=>{const {selectedScenarios}=await import("./policy.mjs");const d=selectedScenarios(true,"native-profile");assert.equal(d.length,1);assert.equal(d[0].acceptanceRole,"diagnostic-only");assert.equal(d[0].nativeTrace,true);assert.deepEqual(d[0].fixtures,["jpeg-near-limit"]);assert.ok(selectedScenarios(true,"combined").every(s=>!s.nativeTrace));});

test("worker and allocator experiments remain diagnostic with unchanged fixture and acceptance",async()=>{const {selectedScenarios}=await import("./policy.mjs");for(const p of ["native-worker","native-mmap"]){const d=selectedScenarios(true,p);assert.equal(d.length,1);assert.equal(d[0].acceptanceRole,"diagnostic-only");assert.equal(d[0].ops,8);assert.deepEqual(d[0].fixtures,["jpeg-near-limit"]);}assert.ok(selectedScenarios(true,"combined").every(s=>!s.recipeWorker&&!s.mmapPolicy&&!s.nativeTrace));});

test('final combined mode verifies exact bytes and forbids allocator/worker instrumentation',async()=>{
 const {selectedScenarios,validateCombinedMode,COMBINED_INPUT_SHA}=await import('./policy.mjs');
 const scenario=selectedScenarios(true,'combined')[0],fixture={name:'jpeg-near-limit',width:6000,height:4000,sizeBytes:9670997};
 assert.equal(validateCombinedMode(scenario,{},fixture,COMBINED_INPUT_SHA).role,'acceptance');
 for(const env of [{LD_PRELOAD:'tracer'},{MALLOC_MMAP_THRESHOLD_:'131072'},{MALLOC_ARENA_MAX:'1'},{NOCTELLA_NATIVE_TRACE:'synthetic-only'}])assert.throws(()=>validateCombinedMode(scenario,env,fixture,COMBINED_INPUT_SHA));
 for(const override of [{ops:7},{recipeWorker:true},{mmapPolicy:true},{nativeTrace:true}])assert.throws(()=>validateCombinedMode({...scenario,...override},{},fixture,COMBINED_INPUT_SHA));
 assert.throws(()=>validateCombinedMode(scenario,{},fixture,'wrong'));assert.throws(()=>validateCombinedMode(scenario,{},{...fixture,width:4032},COMBINED_INPUT_SHA));
});
test("#390 allocator experiments are diagnostic-only, keep the 24MP workload and are refused by acceptance",async()=>{const {selectedScenarios,validateCombinedMode,COMBINED_INPUT_SHA,ALLOCATOR_EXPERIMENTS,allocatorEnvArgs}=await import("./policy.mjs");const d=selectedScenarios(true,"native-allocators");assert.deepEqual(d.map(s=>s.allocatorExperiment),Object.keys(ALLOCATOR_EXPERIMENTS));for(const s of d){assert.equal(s.acceptanceRole,"diagnostic-only");assert.equal(s.ops,8);assert.equal(s.concurrency,3);assert.equal(s.path,"combined");assert.deepEqual(s.fixtures,["jpeg-near-limit"]);}const fixture={name:"jpeg-near-limit",width:6000,height:4000,sizeBytes:9670997};const acceptance=selectedScenarios(true,"combined")[0];assert.ok(selectedScenarios(true,"combined").every(s=>!s.allocatorExperiment));assert.throws(()=>validateCombinedMode({...acceptance,allocatorExperiment:"jemalloc"},{},fixture,COMBINED_INPUT_SHA),/diagnostic overrides/);for(const name of Object.keys(ALLOCATOR_EXPERIMENTS)){const env=Object.fromEntries(allocatorEnvArgs(name).filter((_,i)=>i%2).map(kv=>kv.split("=")));assert.throws(()=>validateCombinedMode(acceptance,env,fixture,COMBINED_INPUT_SHA),/diagnostic overrides/);assert.deepEqual(validateCombinedMode(d.find(s=>s.allocatorExperiment===name),env,fixture,COMBINED_INPUT_SHA).allocator,ALLOCATOR_EXPERIMENTS[name].env);}assert.throws(()=>validateCombinedMode(acceptance,{MIMALLOC_PURGE_DELAY:"0"},fixture,COMBINED_INPUT_SHA));assert.equal(validateCombinedMode(acceptance,{},fixture,COMBINED_INPUT_SHA).role,"acceptance");});
test("#390 libvips RGB-free experiment: isolated native cases before allocator combinations, diagnostic-only, parity enforced",async()=>{const {selectedScenarios,validateCombinedMode,COMBINED_INPUT_SHA,diagnosticEnvArgs,compareParity,LIBVIPS_VARIANTS}=await import("./policy.mjs");const d=selectedScenarios(true,"native-rgbfree");assert.deepEqual(d.map(s=>[s.libvipsVariant,s.allocatorExperiment??null]),[["prebuilt","glibc-arena1-mmap"],["unmodified",null],["patched",null],["unmodified","glibc-arena1-mmap"],["patched","glibc-arena1-mmap"]]);assert.equal(d.filter(s=>s.parityReference).length,1);for(const p of ["native-rgbfree","native-rgbfree-trials","native-rgbfree-alloc-trials"])for(const s of selectedScenarios(true,p)){assert.equal(s.acceptanceRole,"diagnostic-only");assert.equal(s.ops,8);assert.equal(s.concurrency,3);assert.deepEqual(s.fixtures,["jpeg-near-limit"]);assert.equal(s.parityGroup,"rgbfree");}const t=selectedScenarios(true,"native-rgbfree-trials"),a=selectedScenarios(true,"native-rgbfree-alloc-trials");assert.deepEqual(t.slice(1).map(s=>[s.libvipsVariant,s.allocatorExperiment??null,s.trial]),[["patched",null,1],["patched",null,2],["patched",null,3]]);assert.deepEqual(a.slice(1).map(s=>[s.libvipsVariant,s.allocatorExperiment,s.trial]),[["patched","glibc-arena1-mmap",1],["patched","glibc-arena1-mmap",2],["patched","glibc-arena1-mmap",3]]);
assert.deepEqual(diagnosticEnvArgs(d[2]),["--env","LD_PRELOAD="+LIBVIPS_VARIANTS.patched.preload]);assert.deepEqual(diagnosticEnvArgs(d[0]),["--env","MALLOC_ARENA_MAX=1","--env","MALLOC_MMAP_THRESHOLD_=131072","--env","MALLOC_TRIM_THRESHOLD_=131072"]);assert.ok(diagnosticEnvArgs(d[4]).includes("LD_PRELOAD="+LIBVIPS_VARIANTS.patched.preload)&&diagnosticEnvArgs(d[4]).includes("MALLOC_ARENA_MAX=1"));
const fixture={name:"jpeg-near-limit",width:6000,height:4000,sizeBytes:9670997};const acceptance=selectedScenarios(true,"combined")[0];assert.throws(()=>validateCombinedMode({...acceptance,libvipsVariant:"patched"},{},fixture,COMBINED_INPUT_SHA),/diagnostic overrides/);assert.throws(()=>validateCombinedMode(acceptance,{LD_PRELOAD:LIBVIPS_VARIANTS.patched.preload},fixture,COMBINED_INPUT_SHA),/diagnostic overrides/);assert.equal(validateCombinedMode(d[2],{LD_PRELOAD:LIBVIPS_VARIANTS.patched.preload},fixture,COMBINED_INPUT_SHA).libvipsVariant,"patched");
const ref={name:"r",parityGroup:"g",parityReference:true,digests:["a","b"]};assert.equal(compareParity([ref,{name:"x",parityGroup:"g",digests:["a","b"]}]).ok,true);const mm=compareParity([ref,{name:"x",parityGroup:"g",digests:["a","c"]}]);assert.equal(mm.ok,false);assert.deepEqual(mm.groups.g.results[0],{name:"x",status:"MISMATCH",onlyInReference:["b"],onlyInCase:["c"]});assert.equal(compareParity([ref,{name:"x",parityGroup:"g",digests:null}]).groups.g.results[0].status,"MISSING");assert.equal(compareParity([{...ref,digests:null},{name:"x",parityGroup:"g",digests:["a","b"]}]).ok,false);assert.equal(compareParity([{name:"plain"}]).ok,true);});
