import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateFixtures } from "./photoMemoryBenchmark/fixtures";
import { renderMarkdown, type BenchmarkEnvironment, type BenchmarkReport, type ScenarioOutcome } from "./photoMemoryBenchmark/report";
import { PROFILES, type BenchmarkProfile, type ScenarioSpec } from "./photoMemoryBenchmark/scenarios";
import { runScenario, type WorkerConfig } from "./photoMemoryBenchmark/worker";

/**
 * P2-1 (#373): offline product-photo memory benchmark.
 *
 *   npm run photos:memory-benchmark -w apps/api -- [--profile full|quick] [--only <regex>] [--out <dir>] [--preserve-fixtures <new-dir>]
 *
 * Generates synthetic fixtures, then runs every scenario in a fresh child
 * process against the unmodified services/photoStorage.ts pipeline. All
 * outputs and Sharp/libvips temp files live under one OS temp directory
 * removed on success and failure. Fixtures are also disposable by default;
 * --preserve-fixtures retains them in a separate new directory. Children receive a
 * minimal environment (no credentials, no DATABASE_URL); no network is used.
 */

export interface RunOptions {
  profile: BenchmarkProfile["name"];
  only?: RegExp;
  outDir?: string;
  /** Optional new directory retaining synthetic inputs for audit; never overwritten or removed. */
  preserveFixturesDir?: string;
  scenarioTimeoutMs?: number;
  log?: (line: string) => void;
}

const API_ROOT = path.resolve(__dirname, "..", "..");

function childExecArgv(): string[] {
  // Under tsx/vitest this file is TypeScript; compiled dist runs as plain JS.
  return __filename.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function childEnv(photoDir: string, tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PRODUCT_PHOTO_DIR: photoDir, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir, NODE_ENV: "test" };
  for (const key of ["PATH", "Path", "SystemRoot", "windir", "UV_THREADPOOL_SIZE", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: API_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function describeEnvironment(profile: string): BenchmarkEnvironment {
  const cpus = os.cpus();
  return {
    generatedAt: new Date().toISOString(),
    profile,
    node: process.version,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(),
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "default (4)",
    gitCommit: gitCommit(),
  };
}

function runChild(configFile: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ exitCode: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...childExecArgv(), __filename, "--worker", configFile], { cwd: API_ROOT, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stderr: error.message });
    });
  });
}

async function runIsolatedScenario(scenario: ScenarioSpec, fixtures: WorkerConfig["fixtures"], workRoot: string, index: number, timeoutMs: number): Promise<ScenarioOutcome> {
  const scenarioDir = path.join(workRoot, `scenario-${String(index).padStart(2, "0")}`);
  const photoDir = path.join(scenarioDir, "photos");
  const tmpDir = path.join(scenarioDir, "tmp");
  const resultFile = path.join(scenarioDir, "result.json");
  const configFile = path.join(scenarioDir, "config.json");
  let outcome: ScenarioOutcome = { scenario, cleanedUp: false };
  try {
    await mkdir(photoDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const config: WorkerConfig = { scenario, fixtures, photoDir, tmpDir, resultFile };
    await writeFile(configFile, JSON.stringify(config));
    const child = await runChild(configFile, childEnv(photoDir, tmpDir), timeoutMs);
    const raw = await readFile(resultFile, "utf8").catch(() => undefined);
    outcome = raw && child.exitCode === 0
      ? { scenario, result: JSON.parse(raw), cleanedUp: false }
      : { scenario, crash: { exitCode: child.exitCode, signal: child.signal, stderrTail: child.stderr.slice(-600) }, cleanedUp: false };
  } finally {
    await rm(scenarioDir, { recursive: true, force: true, maxRetries: 3 });
    outcome.cleanedUp = !existsSync(scenarioDir);
  }
  return outcome;
}

export async function runBenchmark(options: RunOptions): Promise<BenchmarkReport> {
  const log = options.log ?? (() => undefined);
  const profile = PROFILES[options.profile];
  const scenarios = profile.scenarios.filter((scenario) => !options.only || options.only.test(scenario.name));
  const environment = describeEnvironment(profile.name);
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-bench-"));
  const outcomes: ScenarioOutcome[] = [];
  let fixtures: WorkerConfig["fixtures"] = [];
  try {
    const fixturesDir = options.preserveFixturesDir ?? path.join(workRoot, "fixtures");
    await mkdir(fixturesDir);
    log(`Generating ${profile.fixtures.length} fixtures...`);
    fixtures = await generateFixtures(profile.fixtures, fixturesDir);
    if (options.preserveFixturesDir) await writeFile(path.join(fixturesDir, "fixtures.json"), JSON.stringify(fixtures, null, 2), { flag: "wx" });
    for (const [index, scenario] of scenarios.entries()) {
      log(`[${index + 1}/${scenarios.length}] ${scenario.name}`);
      outcomes.push(await runIsolatedScenario(scenario, fixtures, workRoot, index, options.scenarioTimeoutMs ?? 10 * 60_000));
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 3 });
  }
  const report: BenchmarkReport = {
    environment,
    fixtures: fixtures.map(({ file: _file, ...fixture }) => fixture),
    outcomes,
    workRootRemoved: !existsSync(workRoot),
  };
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    const stamp = environment.generatedAt.replace(/[:.]/g, "-");
    await writeFile(path.join(options.outDir, `photo-memory-${profile.name}-${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(path.join(options.outDir, `photo-memory-${profile.name}-${stamp}.md`), renderMarkdown(report));
  }
  return report;
}

export function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = { profile: "full" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--profile") {
      const profile = value();
      if (profile !== "full" && profile !== "quick") throw new Error("--profile must be full or quick");
      options.profile = profile;
    } else if (arg === "--only") options.only = new RegExp(value());
    else if (arg === "--out") options.outDir = path.resolve(value());
    else if (arg === "--preserve-fixtures") options.preserveFixturesDir = path.resolve(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function workerMain(configFile: string) {
  const config = JSON.parse(await readFile(configFile, "utf8")) as WorkerConfig;
  const result = await runScenario(config);
  await writeFile(config.resultFile, JSON.stringify(result));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    await workerMain(argv[1]);
    return;
  }
  const options = parseArgs(argv);
  const report = await runBenchmark({ ...options, log: (line) => console.error(line) });
  console.log(renderMarkdown(report));
  const crashed = report.outcomes.filter((outcome) => outcome.crash).length;
  const unexpected = report.outcomes.reduce((count, outcome) => count + (outcome.result?.operations.filter((op) => !op.asExpected).length ?? 0), 0);
  const leftovers = report.outcomes.some((outcome) => outcome.result && (outcome.result.leftovers.photoDirFiles !== outcome.result.leftovers.expectedPhotoDirFiles || outcome.result.leftovers.tmpDirFiles.length > 0));
  if (!report.workRootRemoved || report.outcomes.some((outcome) => !outcome.cleanedUp)) process.exitCode = 2;
  else if (crashed || unexpected || leftovers) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
