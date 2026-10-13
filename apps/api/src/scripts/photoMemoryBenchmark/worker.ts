import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { GeneratedFixture } from "./fixtures";
import { maxRssBytes, snapshot, startSampler, type MemoryPeaks, type MemorySnapshot } from "./metrics";
import type { ScenarioSpec } from "./scenarios";

/**
 * P2-1 (#373): runs one scenario against the unmodified production photo
 * pipeline (services/photoStorage.ts) inside the current process. The runner
 * executes each scenario in a fresh child process with PRODUCT_PHOTO_DIR and
 * TMP/TEMP/TMPDIR pointed at an isolated temp directory, so peak RSS is per
 * scenario and nothing reaches the real uploads directory.
 */

export interface WorkerConfig {
  scenario: ScenarioSpec;
  fixtures: GeneratedFixture[];
  photoDir: string;
  tmpDir: string;
  resultFile: string;
}

export interface OperationResult {
  index: number;
  fixture: string;
  ok: boolean;
  durationMs: number;
  inputBytes: number;
  outputWidth?: number;
  outputHeight?: number;
  mainBytes?: number;
  thumbBytes?: number;
  errorClass?: string;
  errorMessage?: string;
  /** Matches the fixture manifest's expectation (valid input succeeded / invalid input was rejected). */
  asExpected: boolean;
}

export interface ScenarioResult {
  scenario: ScenarioSpec;
  baseline: MemorySnapshot;
  baselineMaxRss: number;
  peak: MemoryPeaks;
  peakMaxRss: number;
  final: MemorySnapshot;
  totalDurationMs: number;
  operations: OperationResult[];
  sharp: { version: string; libvips: string; concurrency: number; cache: unknown; simd: boolean };
  /** tmpDirFiles: files created in the isolated TMP while the scenario ran. */
  leftovers: { photoDirFiles: number; expectedPhotoDirFiles: number; tmpDirFiles: string[] };
}

function errorSummary(error: unknown) {
  const err = error as { constructor?: { name?: string }; message?: unknown };
  const message = typeof err?.message === "string" ? err.message : String(error);
  return { errorClass: err?.constructor?.name ?? "Unknown", errorMessage: message.split(/\r?\n/)[0].slice(0, 200) };
}

async function runPool<T>(count: number, concurrency: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await task(index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(full)));
    else files.push(path.relative(dir, full));
  }
  return files;
}

export async function runScenario(config: WorkerConfig): Promise<ScenarioResult> {
  // photoStorage reads PRODUCT_PHOTO_DIR at module load, so it must be set before the import.
  process.env.PRODUCT_PHOTO_DIR = config.photoDir;
  const sharp = (await import("sharp")).default;
  const storage = await import("../../services/photoStorage");
  if (path.resolve(storage.productPhotoStaticRoot) !== path.resolve(config.photoDir)) {
    throw new Error("Refusing to run: photo storage root is not the isolated benchmark directory");
  }
  if (config.scenario.sharpConcurrency !== undefined) sharp.concurrency(config.scenario.sharpConcurrency);
  if (config.scenario.sharpCacheDisabled) sharp.cache(false);

  const fixtures = new Map(config.fixtures.map((fixture) => [fixture.name, fixture]));
  const { scenario } = config;
  // Files already in the isolated TMP before processing (e.g. the tsx compile cache) are not pipeline leftovers.
  const preexistingTmpFiles = new Set(await listFilesRecursive(config.tmpDir));
  const baseline = snapshot();
  const baselineMaxRss = maxRssBytes();
  const sampler = startSampler();
  const started = performance.now();

  const operations = await runPool(scenario.ops, scenario.concurrency, async (index): Promise<OperationResult> => {
    const fixture = fixtures.get(scenario.fixtures[index % scenario.fixtures.length]);
    if (!fixture) throw new Error(`Unknown fixture in scenario ${scenario.name}`);
    // Models multer.memoryStorage(): each in-flight request owns a full Buffer of the upload.
    const buffer = await readFile(fixture.file);
    const file = { buffer, mimetype: fixture.mimetype, size: buffer.length };
    const opStarted = performance.now();
    try {
      if (scenario.path === "deterministic") {
        const key = scenario.reuseDestination ? "bench-retry" : `bench-${index}`;
        const saved = await storage.writeDeterministicProductPhoto({ ...file, mainStorageKey: `${key}.webp`, thumbnailStorageKey: `${key}-thumb.webp` });
        const durationMs = performance.now() - opStarted;
        const [main, thumb] = await Promise.all([stat(path.join(config.photoDir, saved.mainStorageKey)), stat(path.join(config.photoDir, saved.thumbnailStorageKey))]);
        return { index, fixture: fixture.name, ok: true, durationMs, inputBytes: buffer.length, outputWidth: saved.width, outputHeight: saved.height, mainBytes: main.size, thumbBytes: thumb.size, asExpected: fixture.expectValid };
      }
      const saved = await storage.photoStorage.saveProductPhoto(file);
      const durationMs = performance.now() - opStarted;
      const [main, thumb] = await Promise.all([stat(path.join(config.photoDir, path.basename(saved.url))), stat(path.join(config.photoDir, path.basename(saved.thumbnailUrl)))]);
      return { index, fixture: fixture.name, ok: true, durationMs, inputBytes: buffer.length, outputWidth: saved.width, outputHeight: saved.height, mainBytes: main.size, thumbBytes: thumb.size, asExpected: fixture.expectValid };
    } catch (error) {
      return { index, fixture: fixture.name, ok: false, durationMs: performance.now() - opStarted, inputBytes: buffer.length, ...errorSummary(error), asExpected: !fixture.expectValid };
    }
  });

  const totalDurationMs = performance.now() - started;
  const peak = sampler.stop();
  const peakMaxRss = maxRssBytes();
  const successes = operations.filter((op) => op.ok).length;
  const expectedPhotoDirFiles = scenario.path === "deterministic" && scenario.reuseDestination ? (successes > 0 ? 2 : 0) : successes * 2;

  return {
    scenario,
    baseline,
    baselineMaxRss,
    peak,
    peakMaxRss,
    final: snapshot(),
    totalDurationMs,
    operations,
    sharp: { version: sharp.versions.sharp ?? "unknown", libvips: sharp.versions.vips, concurrency: sharp.concurrency(), cache: sharp.cache(), simd: sharp.simd() },
    leftovers: { photoDirFiles: (await listFilesRecursive(config.photoDir)).length, expectedPhotoDirFiles, tmpDirFiles: (await listFilesRecursive(config.tmpDir)).filter((file) => !preexistingTmpFiles.has(file)) },
  };
}
