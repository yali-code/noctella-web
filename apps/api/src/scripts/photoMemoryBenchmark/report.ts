import type { GeneratedFixture } from "./fixtures";
import { mib, percentile } from "./metrics";
import type { ScenarioSpec } from "./scenarios";
import type { ScenarioResult } from "./worker";

/** P2-1 (#373): JSON + Markdown reporting for the photo memory benchmark. */

export interface BenchmarkEnvironment {
  generatedAt: string;
  profile: string;
  node: string;
  platform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  uvThreadpoolSize: string;
  gitCommit: string;
}

export interface ScenarioOutcome {
  scenario: ScenarioSpec;
  result?: ScenarioResult;
  /** Set when the child process crashed, timed out or produced no result (e.g. native OOM). */
  crash?: { exitCode: number | null; signal: string | null; stderrTail: string };
  /** Isolated scenario directory was deleted after the run. */
  cleanedUp: boolean;
}

export interface BenchmarkReport {
  environment: BenchmarkEnvironment;
  fixtures: Omit<GeneratedFixture, "file">[];
  outcomes: ScenarioOutcome[];
  workRootRemoved: boolean;
}

export interface ScenarioSummary {
  name: string;
  ops: number;
  concurrency: number;
  ok: number;
  failed: number;
  unexpected: number;
  peakRssMiB: string;
  rssOverBaselineMiB: string;
  peakHeapUsedMiB: string;
  peakExternalMiB: string;
  peakArrayBuffersMiB: string;
  p50Ms: number;
  maxMs: number;
  totalMs: number;
  avgMainKiB: number;
  avgThumbKiB: number;
  leftovers: string;
  status: "ok" | "crashed";
}

export function summarize(outcome: ScenarioOutcome): ScenarioSummary {
  const { scenario, result } = outcome;
  if (!result) {
    return { name: scenario.name, ops: scenario.ops, concurrency: scenario.concurrency, ok: 0, failed: 0, unexpected: scenario.ops, peakRssMiB: "-", rssOverBaselineMiB: "-", peakHeapUsedMiB: "-", peakExternalMiB: "-", peakArrayBuffersMiB: "-", p50Ms: 0, maxMs: 0, totalMs: 0, avgMainKiB: 0, avgThumbKiB: 0, leftovers: "n/a", status: "crashed" };
  }
  const ok = result.operations.filter((op) => op.ok);
  const durations = result.operations.map((op) => op.durationMs);
  const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length / 1024) : 0);
  const unexpectedFiles = result.leftovers.photoDirFiles - result.leftovers.expectedPhotoDirFiles;
  return {
    name: scenario.name,
    ops: scenario.ops,
    concurrency: scenario.concurrency,
    ok: ok.length,
    failed: result.operations.length - ok.length,
    unexpected: result.operations.filter((op) => !op.asExpected).length,
    peakRssMiB: mib(Math.max(result.peakMaxRss, result.peak.rss)),
    rssOverBaselineMiB: mib(Math.max(result.peakMaxRss, result.peak.rss) - result.baseline.rss),
    peakHeapUsedMiB: mib(result.peak.heapUsed),
    peakExternalMiB: mib(result.peak.external),
    peakArrayBuffersMiB: mib(result.peak.arrayBuffers),
    p50Ms: Math.round(percentile(durations, 50)),
    maxMs: Math.round(Math.max(0, ...durations)),
    totalMs: Math.round(result.totalDurationMs),
    avgMainKiB: average(ok.map((op) => op.mainBytes ?? 0)),
    avgThumbKiB: average(ok.map((op) => op.thumbBytes ?? 0)),
    leftovers: unexpectedFiles === 0 && result.leftovers.tmpDirFiles.length === 0 ? "none" : `photos ${unexpectedFiles >= 0 ? "+" : ""}${unexpectedFiles}, tmp ${result.leftovers.tmpDirFiles.length}`,
    status: "ok",
  };
}

function table(headers: string[], rows: (string | number)[][]): string {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function renderMarkdown(report: BenchmarkReport): string {
  const env = report.environment;
  const sharp = report.outcomes.find((outcome) => outcome.result)?.result?.sharp;
  const lines: string[] = [
    `# Product photo memory benchmark (${env.profile})`,
    "",
    `Generated ${env.generatedAt} at commit \`${env.gitCommit}\`.`,
    "",
    table(["Item", "Value"], [
      ["Node", env.node],
      ["OS", `${env.platform} ${env.osRelease} (${env.arch})`],
      ["CPU", `${env.cpuModel}, ${env.logicalCpus} logical`],
      ["Total memory", `${mib(env.totalMemoryBytes, 0)} MiB`],
      ["UV_THREADPOOL_SIZE", env.uvThreadpoolSize],
      ["Sharp / libvips", sharp ? `${sharp.version} / ${sharp.libvips}` : "n/a"],
      ["Sharp default concurrency / SIMD", sharp ? `${sharp.concurrency} / ${sharp.simd}` : "n/a"],
    ]),
    "",
    "## Fixtures",
    "",
    table(["Fixture", "MIME", "Bytes", "MiB", "Pixels", "MP", "Quality", "Expect"], report.fixtures.map((fixture) => [
      fixture.name, fixture.mimetype, fixture.sizeBytes, mib(fixture.sizeBytes, 2), fixture.width ? `${fixture.width}x${fixture.height}` : "-", fixture.megapixels ?? "-", fixture.quality ?? "-", fixture.expectValid ? "process" : "reject",
    ])),
    "",
    "## Scenarios",
    "",
    "Peak RSS is the OS-reported process peak (`resourceUsage().maxRSS`, includes native Sharp/libvips memory). Heap, external and ArrayBuffer peaks are sampled every 5 ms. Over-baseline is peak RSS minus RSS after loading Sharp and the photo service.",
    "",
    table(["Scenario", "Ops", "Conc", "OK", "Fail", "Unexpected", "Peak RSS MiB", "Over baseline MiB", "Heap MiB", "External MiB", "ArrayBuffers MiB", "p50 ms", "Max ms", "Total ms", "Avg main KiB", "Avg thumb KiB", "Leftovers"], report.outcomes.map(summarize).map((s) => [
      s.status === "crashed" ? `${s.name} **CRASHED**` : s.name, s.ops, s.concurrency, s.ok, s.failed, s.unexpected, s.peakRssMiB, s.rssOverBaselineMiB, s.peakHeapUsedMiB, s.peakExternalMiB, s.peakArrayBuffersMiB, s.p50Ms, s.maxMs, s.totalMs, s.avgMainKiB, s.avgThumbKiB, s.leftovers,
    ])),
    "",
    "## Failures",
    "",
  ];
  const failures = report.outcomes.flatMap((outcome) => (outcome.result?.operations ?? []).filter((op) => !op.ok).map((op) => ({ scenario: outcome.scenario.name, op })));
  const unique = new Map<string, { scenario: string; fixture: string; errorClass?: string; errorMessage?: string; asExpected: boolean }>();
  for (const { scenario, op } of failures) unique.set(`${op.fixture}|${op.errorClass}|${op.errorMessage}`, { scenario, fixture: op.fixture, errorClass: op.errorClass, errorMessage: op.errorMessage, asExpected: op.asExpected });
  lines.push(unique.size === 0 ? "No operation failed." : table(["Fixture", "Error class", "Message", "Expected"], [...unique.values()].map((f) => [f.fixture, f.errorClass ?? "-", (f.errorMessage ?? "").replace(/\|/g, "/"), f.asExpected ? "yes" : "**no**"])));
  const crashes = report.outcomes.filter((outcome) => outcome.crash);
  if (crashes.length) {
    lines.push("", "## Crashed scenarios", "", table(["Scenario", "Exit", "Signal", "stderr (tail)"], crashes.map((c) => [c.scenario.name, String(c.crash?.exitCode), String(c.crash?.signal), (c.crash?.stderrTail ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/").slice(0, 200)])));
  }
  lines.push("", "## Cleanup", "", `Scenario directories removed: ${report.outcomes.filter((o) => o.cleanedUp).length}/${report.outcomes.length}. Work root removed: ${report.workRootRemoved ? "yes" : "**no**"}.`, "");
  return lines.join("\n");
}
