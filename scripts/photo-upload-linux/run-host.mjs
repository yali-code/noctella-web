import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { SOURCE_SHA, DISK_STOP_BYTES, SCENARIO_TIMEOUT_MS, selectedScenarios, parseEvents, parseProcStatus, validateLimits, assess, allocatorEnvArgs } from "./policy.mjs";

const output = path.resolve(process.argv[2] ?? "photo-memory-results");
const fixtureRoot = path.resolve(process.argv[3] ?? "");
const image = "noctella-photo-upload:isolated";
const includeStress = process.env.INCLUDE_STRESS !== "false";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
const write = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n");
const record = { schemaVersion: 1, sourceSha: SOURCE_SHA, harnessSha: process.env.HARNESS_SHA ?? "unknown", runUrl: process.env.RUN_URL ?? "local", startedAt: new Date().toISOString(), scope: "gated real product HTTP route; synthetic SQLite and in-process streaming client; not final API acceptance", cases: [] };

async function usage(root) {
  let logical = 0, allocated = 0, files = 0;
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const child = await usage(target); logical += child.logical; allocated += child.allocated; files += child.files;
    } else {
      const s = await fsp.lstat(target);
      if (s.isSymbolicLink()) throw Error("Unexpected symlink in disposable work directory");
      logical += s.size; allocated += s.blocks * 512; files++;
    }
  }
  return { logical, allocated, files };
}
async function inventory(root, dir = root, result = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), info = await fsp.lstat(file);
    if (info.isSymbolicLink()) throw Error("Unexpected symlink in disposable inventory");
    if (entry.isDirectory()) await inventory(root, file, result);
    else { if (result.length >= 1000) throw Error("Inventory budget exceeded"); result.push({ path: path.relative(root, file), size: info.size }); }
  }
  return result;
}
async function cgroup(root) {
  const value = async (name) => (await fsp.readFile(path.join(root, name), "utf8")).trim();
  return { max: Number(await value("memory.max")), swapMax: Number(await value("memory.swap.max")), current: Number(await value("memory.current")), peak: Number(await value("memory.peak")), events: parseEvents(await value("memory.events")) };
}
async function processes(cg) {
  const pids = (await fsp.readFile(path.join(cg, "cgroup.procs"), "utf8")).trim().split(/\s+/).filter(Boolean);
  return (await Promise.all(pids.map(async pid => {
    const text = await fsp.readFile("/proc/" + pid + "/status", "utf8").catch(() => null);
    return text ? { pid: Number(pid), ...parseProcStatus(text) } : null;
  }))).filter(Boolean);
}
function safeChild(root, child) {
  if (path.dirname(child) !== root || !path.basename(child).startsWith("case-")) throw Error("Refusing unsafe disposable cleanup");
}
async function run() {
  if (process.platform !== "linux" || !fixtureRoot || fixtureRoot === output) throw Error("Linux and distinct fixture/output roots required");
  await fsp.mkdir(output, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "noctella-linux-cases-"));
  const fixtures = JSON.parse(await fsp.readFile(path.join(fixtureRoot, "fixtures.json"), "utf8"));
  record.fixtures = fixtures.map(({ file, ...rest }) => rest);
  record.host = { platform: process.platform, kernel: os.release(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(), dockerVersion: docker("version", "--format", "{{.Server.Version}}").trim(), image: JSON.parse(docker("image", "inspect", image))[0].Id };
  await write(path.join(output, "summary.json"), record);
  console.log(JSON.stringify({ type: "environment", sourceSha: SOURCE_SHA, harnessSha: record.harnessSha, runUrl: record.runUrl, host: record.host, fixtures: record.fixtures }));
  for (const [index, scenario] of selectedScenarios(includeStress, process.env.CASE_PROFILE ?? "full").entries()) {
    const evidence = path.join(output, scenario.name);
    await fsp.mkdir(evidence);
    const work = path.join(tempRoot, "case-" + index);
    safeChild(tempRoot, work);
    await fsp.mkdir(path.join(work, "photos"), { recursive: true });
    await fsp.mkdir(path.join(work, "tmp"));
    await write(path.join(work, "config.json"), { scenario, fixtures, photoDir: "/work/photos", tmpDir: "/work/tmp", resultFile: "/evidence/result.json" });
    const item = { scenario, exitCode: null, timedOut: false, diskStopped: false, cleanup: false, samples: 0, observedProcessRss: 0, observedProcessHwm: 0, observedGroupRss: 0, diskPeak: { logical: 0, allocated: 0, files: 0 } };
    let name, sampler, sampling = false, samplingJob = Promise.resolve();
    try {
      name = "noctella-photo-" + process.pid + "-" + index;
      docker("create", "--name", name, "--network", "none", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", process.getuid() + ":" + process.getgid(), "--mount", "type=bind,src=" + fixtureRoot + ",dst=/fixtures,readonly", "--mount", "type=bind,src=" + work + ",dst=/work", "--mount", "type=bind,src=" + evidence + ",dst=/evidence", image);
      docker("start", name);
      const inspect = JSON.parse(docker("inspect", name))[0];
      if (inspect.HostConfig.NetworkMode !== "none" || inspect.HostConfig.Memory !== 536870912 || inspect.HostConfig.MemorySwap !== 536870912 || !inspect.HostConfig.ReadonlyRootfs || inspect.Mounts.some(m => m.Destination.includes("docker.sock"))) throw Error("Unsafe Docker isolation configuration");
      item.isolation = { network: inspect.HostConfig.NetworkMode, memory: inspect.HostConfig.Memory, memorySwap: inspect.HostConfig.MemorySwap, readOnlyRoot: inspect.HostConfig.ReadonlyRootfs, cpuNano: inspect.HostConfig.NanoCpus, pidsLimit: inspect.HostConfig.PidsLimit, mounts: inspect.Mounts.map(m => ({ destination: m.Destination, rw: m.RW })) };
      docker("exec", name, "node", "--import", "tsx", "scripts/photo-upload-linux/agent.ts", "preflight");
      item.preflight = JSON.parse(await fsp.readFile(path.join(evidence, "preflight.json"), "utf8"));
      const entry = (await fsp.readFile("/proc/" + inspect.State.Pid + "/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"));
      if (!entry) throw Error("INCONCLUSIVE: host cgroup v2 path unavailable");
      const cg = path.join("/sys/fs/cgroup", entry.slice(3));
      item.before = await cgroup(cg);
      validateLimits(item.before, item.preflight.networkNames);
      const sample = async () => {
        const [memory, disk, procs] = await Promise.all([cgroup(cg), usage(work), processes(cg)]);
        item.observedProcessRss = Math.max(item.observedProcessRss, ...procs.map(p => p.rss));
        item.observedProcessHwm = Math.max(item.observedProcessHwm, ...procs.map(p => p.hwm));
        item.observedGroupRss = Math.max(item.observedGroupRss, procs.reduce((sum, p) => sum + p.rss, 0));
        item.lastSample = memory;
        item.diskPeak.logical = Math.max(item.diskPeak.logical, disk.logical);
        item.diskPeak.allocated = Math.max(item.diskPeak.allocated, disk.allocated);
        item.diskPeak.files = Math.max(item.diskPeak.files, disk.files);
        item.samples++;
        if (item.samples <= 2000) await fsp.appendFile(path.join(evidence, "samples.ndjson"), JSON.stringify({ elapsedMs: Date.now() - item.startedMs, memory, disk, processes: procs }) + "\n");
        if (disk.allocated > DISK_STOP_BYTES && !item.diskStopped) {
          item.diskStopped = true;
          docker("kill", name);
        }
      };
      item.startedMs = Date.now();
      await sample();
      sampler = setInterval(() => {
        if (sampling) return;
        sampling = true;
        samplingJob = sample().catch(error => { item.samplingError = String(error); }).finally(() => { sampling = false; });
      }, 50);
      item.exitCode = await new Promise((resolve) => {
        const diagnosticEnv = scenario.allocatorExperiment ? allocatorEnvArgs(scenario.allocatorExperiment) : scenario.mmapPolicy ? ["--env", "MALLOC_MMAP_THRESHOLD_=131072", "--env", "MALLOC_TRIM_THRESHOLD_=131072"] : scenario.nativeTrace ? ["--env", "LD_PRELOAD=/app/scripts/photo-upload-linux/native-alloc.so", "--env", "NOCTELLA_NATIVE_TRACE=synthetic-only"] : [];
        const child = spawn("docker", ["exec", ...diagnosticEnv, name, "node", "--import", "tsx", "scripts/photo-upload-linux/agent.ts", "run"], { stdio: ["ignore", "pipe", "pipe"] });
        let log = "";
        child.stdout.on("data", chunk => { log = (log + chunk.toString()).slice(-64000); });
        child.stderr.on("data", chunk => { log = (log + chunk.toString()).slice(-64000); });
        const timer = setTimeout(() => { item.timedOut = true; try { docker("kill", name); } catch {} }, SCENARIO_TIMEOUT_MS);
        child.on("error", error => { clearTimeout(timer); log += String(error); resolve(-1); });
        child.on("close", async code => { clearTimeout(timer); await fsp.writeFile(path.join(evidence, "worker-log.txt"), log); resolve(code ?? -1); });
      });
      clearInterval(sampler); sampler = undefined;
      await samplingJob;
      item.after = await cgroup(cg).catch(() => null);
      item.dockerState = JSON.parse(docker("inspect", name))[0].State;
      item.oomKilled = item.dockerState.OOMKilled;
      item.result = JSON.parse(await fsp.readFile(path.join(evidence, "result.json"), "utf8").catch(() => "null"));
      item.finalDisk = await usage(work);
      item.finalInventory = await inventory(work);
      item.diskPeak.logical = Math.max(item.diskPeak.logical, item.finalDisk.logical);
      item.diskPeak.allocated = Math.max(item.diskPeak.allocated, item.finalDisk.allocated);
      item.diskPeak.files = Math.max(item.diskPeak.files, item.finalDisk.files);
    } catch (error) {
      item.harnessError = String(error);
    } finally {
      if (sampler) clearInterval(sampler);
      await samplingJob;
      if (name) {
        try { docker("rm", "--force", name); } catch (error) { item.containerCleanupError = String(error); }
      }
      try { safeChild(tempRoot, work); await fsp.rm(work, { recursive: true, force: true }); item.cleanup = !fs.existsSync(work); }
      catch (error) { item.cleanupError = String(error); }
      item.assessment = assess(item);
      if (item.harnessError || item.samplingError || item.containerCleanupError) item.assessment = { status: "INCONCLUSIVE", reason: "Harness/observer/isolation failure" };
      await write(path.join(evidence, "host-evidence.json"), item);
      record.cases.push(item);
      await write(path.join(output, "summary.json"), record);
      console.log(JSON.stringify({ scenario: scenario.name, status: item.assessment.status, peakCgroupMiB: item.after ? item.after.peak / 1048576 : null, peakProcessMiB: item.result ? Math.max(item.result.peakMaxRss, item.result.peak.rss) / 1048576 : null, exitCode: item.exitCode, timedOut: item.timedOut, oomKilled: item.oomKilled, cgroupBefore: item.before, cgroupAfter: item.after, events: item.assessment.delta, observedProcessRssBytes: item.observedProcessRss, observedProcessHwmBytes: item.observedProcessHwm, peakHeapMiB: item.result ? item.result.peak.heapUsed / 1048576 : null, peakExternalMiB: item.result ? item.result.peak.external / 1048576 : null, peakArrayBuffersMiB: item.result ? item.result.peak.arrayBuffers / 1048576 : null, durationMs: item.result?.totalDurationMs, operations: item.result?.operations, versions: item.preflight ? { node: item.preflight.node, sharp: item.preflight.sharp, sharpConcurrency: item.preflight.sharpConcurrency } : null, peakDiskBytes: item.diskPeak, cleanup: item.cleanup, reason: item.assessment.reason }));
    }
    if (item.harnessError) break; // Do not collect unrestricted measurements after failed isolation.
  }
  await fsp.rmdir(tempRoot);
  record.finishedAt = new Date().toISOString();
  record.expectedCases = selectedScenarios(includeStress, process.env.CASE_PROFILE ?? "full").length;
  record.status = record.cases.length === record.expectedCases && record.cases.every(c => c.assessment.status === "PASS") ? "PASS" : "FAIL";
  await write(path.join(output, "summary.json"), record);
  const size = await usage(output);
  if (size.logical > 16 * 1024 * 1024) throw Error("Evidence exceeds 16-MiB artifact budget");
  process.exitCode = record.status === "PASS" ? 0 : 1;
}
run().catch(async error => {
  record.fatal = String(error); record.status = "INCONCLUSIVE";
  await fsp.mkdir(output, { recursive: true });
  await write(path.join(output, "summary.json"), record);
  console.error(String(error)); process.exitCode = 2;
});
