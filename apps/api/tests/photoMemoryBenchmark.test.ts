import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createPrng, generateFixtures, NEAR_LIMIT_BYTES, photoLikePixels, PRODUCT_PHOTO_LIMIT_BYTES } from "../src/scripts/photoMemoryBenchmark/fixtures";
import { mergePeak, percentile, snapshot } from "../src/scripts/photoMemoryBenchmark/metrics";
import { renderMarkdown, summarize, type BenchmarkReport } from "../src/scripts/photoMemoryBenchmark/report";
import { PROFILES } from "../src/scripts/photoMemoryBenchmark/scenarios";
import { parseArgs, runBenchmark } from "../src/scripts/runPhotoMemoryBenchmark";
import { PRODUCT_PHOTO_MAX_BYTES, PRODUCT_PHOTO_MIME_TYPES } from "../src/services/photoStorage";

// P2-1 (#373): regression tests for the offline product-photo memory benchmark tooling.

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-bench-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("photo memory benchmark fixtures", () => {
  it("uses a deterministic PRNG and pixel generator", () => {
    const a = createPrng(42);
    const b = createPrng(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(photoLikePixels(16, 8, 3, 20, 9)).toEqual(photoLikePixels(16, 8, 3, 20, 9));
    expect(photoLikePixels(16, 8, 4, 20, 9)).toHaveLength(16 * 8 * 4);
  });

  it("keeps the benchmark limit aligned with the production upload limit", () => {
    expect(PRODUCT_PHOTO_LIMIT_BYTES).toBe(PRODUCT_PHOTO_MAX_BYTES);
    expect(NEAR_LIMIT_BYTES).toBeLessThan(PRODUCT_PHOTO_MAX_BYTES);
  });

  it("rejects mislabeled near-limit fixtures and encoded files above their byte target", async () => {
    const tiny = PROFILES.quick.fixtures[0];
    if (tiny.kind !== "image") throw new Error("Expected image fixture");
    await expect(generateFixtures([{ ...tiny, tags: ["near-limit"] }], await tempDir())).rejects.toThrow("between 9 and 10 MiB");
    await expect(generateFixtures([{ ...tiny, format: "png", targetMaxBytes: 1 }], await tempDir())).rejects.toThrow("declared byte target");
  });

  it("expects unsupported declared MIME types to fail even when bytes contain a valid image", async () => {
    const source = PROFILES.quick.fixtures[0];
    const generated = await generateFixtures([source, { kind: "invalid", name: "gif-mime", mimetype: "image/gif", variant: "mime-mismatch", source: source.name, tags: ["invalid"] }], await tempDir());
    expect(generated[1].expectValid).toBe(false);
    expect(generated[0].sha256).toBe(generated[1].sha256);
  });

  it("generates the quick fixtures reproducibly with the declared dimensions and failure shapes", async () => {
    const first = await generateFixtures(PROFILES.quick.fixtures, await tempDir());
    const second = await generateFixtures(PROFILES.quick.fixtures, await tempDir());
    expect(first.map((fixture) => fixture.sha256)).toEqual(second.map((fixture) => fixture.sha256));

    const byName = new Map(first.map((fixture) => [fixture.name, fixture]));
    for (const fixture of first.filter((f) => f.width)) {
      const metadata = await sharp(await readFile(fixture.file)).metadata();
      expect({ name: fixture.name, width: metadata.width, height: metadata.height, format: metadata.format }).toEqual({ name: fixture.name, width: fixture.width, height: fixture.height, format: fixture.format });
    }
    expect(byName.get("webp-tiny-target")!.sizeBytes).toBeLessThanOrEqual(4096);
    expect(byName.get("invalid-truncated-jpeg")!.sizeBytes).toBe(Math.floor(byName.get("jpeg-tiny-landscape")!.sizeBytes / 2));
    expect(byName.get("invalid-oversize")!.sizeBytes).toBe(PRODUCT_PHOTO_MAX_BYTES + 1);
    expect(byName.get("invalid-oversize")!.expectValid).toBe(false);
  });
});

describe("photo memory benchmark profiles", () => {
  const full = PROFILES.full;
  const images = full.fixtures.filter((fixture) => fixture.kind === "image");

  it("covers every accepted format, both orientations, near-limit and decompression-stress inputs", () => {
    expect(new Set(images.map((fixture) => fixture.kind === "image" && fixture.mimetype))).toEqual(new Set(PRODUCT_PHOTO_MIME_TYPES));
    expect(images.some((fixture) => fixture.kind === "image" && fixture.height > fixture.width)).toBe(true);
    expect(images.some((fixture) => fixture.kind === "image" && fixture.width > fixture.height)).toBe(true);
    for (const format of ["jpeg", "png", "webp"]) {
      expect(images.some((fixture) => fixture.kind === "image" && fixture.format === format && fixture.tags.includes("near-limit"))).toBe(true);
    }
    expect(images.some((fixture) => fixture.tags.includes("decompression-stress"))).toBe(true);
    expect(full.fixtures.filter((fixture) => fixture.kind === "invalid").map((fixture) => fixture.kind === "invalid" && fixture.variant)).toEqual(expect.arrayContaining(["random-bytes", "truncated", "text", "empty", "oversize"]));
  });

  it("covers 10+ sequential uploads and concurrency 1, 2 and 4, with only known fixtures", () => {
    const names = new Set(full.fixtures.map((fixture) => fixture.name));
    for (const scenario of full.scenarios) {
      for (const fixture of scenario.fixtures) expect(names.has(fixture), `${scenario.name} -> ${fixture}`).toBe(true);
    }
    expect(full.scenarios.some((scenario) => scenario.concurrency === 1 && scenario.ops >= 10)).toBe(true);
    expect(new Set(full.scenarios.map((scenario) => scenario.concurrency))).toEqual(new Set([1, 2, 4]));
    expect(full.scenarios.some((scenario) => scenario.path === "deterministic")).toBe(true);
    expect(new Set(full.scenarios.map((scenario) => scenario.name)).size).toBe(full.scenarios.length);
  });
});

describe("photo memory benchmark metrics and reporting", () => {
  it("computes percentiles and merges peaks", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([], 50)).toBe(0);
    const peak = mergePeak({ rss: 10, heapUsed: 5, heapTotal: 6, external: 1, arrayBuffers: 9, samples: 1 }, { rss: 20, heapUsed: 1, heapTotal: 7, external: 2, arrayBuffers: 0 });
    expect(peak).toEqual({ rss: 20, heapUsed: 5, heapTotal: 7, external: 2, arrayBuffers: 9, samples: 2 });
    expect(snapshot().rss).toBeGreaterThan(0);
  });

  it("parses CLI arguments and rejects unknown input", () => {
    expect(parseArgs([])).toEqual({ profile: "full" });
    expect(parseArgs(["--profile", "quick", "--only", "^single-"]).only?.test("single-x")).toBe(true);
    expect(parseArgs(["--preserve-fixtures", "new-fixtures"]).preserveFixturesDir).toBe(path.resolve("new-fixtures"));
    expect(() => parseArgs(["--profile", "huge"])).toThrow();
    expect(() => parseArgs(["--profile"])).toThrow();
    expect(() => parseArgs(["--upload-to-production"])).toThrow();
  });

  it("reports crashed scenarios explicitly instead of hiding them", () => {
    const scenario = PROFILES.quick.scenarios[0];
    const report: BenchmarkReport = {
      environment: { generatedAt: "t", profile: "quick", node: "v", platform: "p", osRelease: "r", arch: "a", cpuModel: "c", logicalCpus: 1, totalMemoryBytes: 1024 ** 3, uvThreadpoolSize: "4", gitCommit: "abc" },
      fixtures: [],
      outcomes: [{ scenario, crash: { exitCode: 134, signal: null, stderrTail: "FATAL ERROR: out of memory" }, cleanedUp: true }],
      workRootRemoved: true,
    };
    expect(summarize(report.outcomes[0]).status).toBe("crashed");
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**CRASHED**");
    expect(markdown).toContain("out of memory");
  });
});

describe("photo memory benchmark end to end (quick profile)", () => {
  it("runs the real photo pipeline in isolated child processes and removes every temp file", async () => {
    const realUploads = path.resolve(process.cwd(), "uploads/product-photos");
    const before = existsSync(realUploads) ? (await readdir(realUploads)).length : -1;
    const outDir = await tempDir();
    const preserveFixturesDir = path.join(await tempDir(), "inputs");

    const report = await runBenchmark({ profile: "quick", outDir, preserveFixturesDir, scenarioTimeoutMs: 60_000 });

    expect(report.workRootRemoved).toBe(true);
    expect(report.outcomes).toHaveLength(PROFILES.quick.scenarios.length);
    for (const outcome of report.outcomes) {
      expect(outcome.crash, outcome.scenario.name).toBeUndefined();
      expect(outcome.cleanedUp).toBe(true);
      const result = outcome.result!;
      expect(result.operations).toHaveLength(outcome.scenario.ops);
      expect(result.operations.every((op) => op.asExpected), outcome.scenario.name).toBe(true);
      expect(result.leftovers.photoDirFiles).toBe(result.leftovers.expectedPhotoDirFiles);
      expect(result.leftovers.tmpDirFiles).toEqual([]);
      expect(result.peakMaxRss).toBeGreaterThan(0);
      for (const op of result.operations.filter((o) => o.ok)) {
        expect(op.mainBytes).toBeGreaterThan(0);
        expect(op.thumbBytes).toBeGreaterThan(0);
      }
    }
    const sequential = report.outcomes[0].result!;
    expect(sequential.operations.filter((op) => !op.ok).map((op) => op.errorClass)).toEqual(expect.arrayContaining(["BadRequestError"]));
    expect((await readdir(outDir)).sort().map((file) => path.extname(file))).toEqual([".json", ".md"]);
    expect((await readdir(preserveFixturesDir))).toHaveLength(PROFILES.quick.fixtures.length + 1);
    const archived = JSON.parse(await readFile(path.join(preserveFixturesDir, "fixtures.json"), "utf8"));
    expect(archived.map((fixture: { sha256: string }) => fixture.sha256)).toEqual(report.fixtures.map((fixture) => fixture.sha256));
    await expect(runBenchmark({ profile: "quick", preserveFixturesDir })).rejects.toThrow();
    expect((await readdir(preserveFixturesDir))).toHaveLength(PROFILES.quick.fixtures.length + 1);
    expect(existsSync(realUploads) ? (await readdir(realUploads)).length : -1).toBe(before);
  }, 120_000);

  it("records a timed-out child as a crash and still removes its temporary directory", async () => {
    const report = await runBenchmark({ profile: "quick", only: /^quick-concurrent-2$/, scenarioTimeoutMs: 1 });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].crash).toBeDefined();
    expect(report.outcomes[0].result).toBeUndefined();
    expect(report.outcomes[0].cleanedUp).toBe(true);
    expect(report.workRootRemoved).toBe(true);
  }, 30_000);
});
