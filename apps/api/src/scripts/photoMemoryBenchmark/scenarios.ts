import { NEAR_LIMIT_BYTES, PRODUCT_PHOTO_LIMIT_BYTES, type FixtureSpec } from "./fixtures";

/**
 * P2-1 (#373): benchmark profiles. "full" is the documented measurement run;
 * "quick" uses tiny fixtures so the tooling itself can be regression-tested.
 */

export interface ScenarioSpec {
  name: string;
  description: string;
  /** Fixture names, cycled until `ops` uploads have been issued. */
  fixtures: string[];
  ops: number;
  /** Uploads in flight at once inside one process (the admin UI itself uploads sequentially). */
  concurrency: number;
  /** "upload": LocalPhotoStorage.saveProductPhoto; "deterministic": writeDeterministicProductPhoto (AI intake finalization). */
  path: "upload" | "deterministic";
  /** Deterministic path only: reuse one destination key so later ops exercise the idempotent-retry read/compare. */
  reuseDestination?: boolean;
  /** Non-production Sharp settings, reported as variants for P2-2 design input only. */
  sharpConcurrency?: number;
  sharpCacheDisabled?: boolean;
}

export interface BenchmarkProfile {
  name: "full" | "quick";
  fixtures: FixtureSpec[];
  scenarios: ScenarioSpec[];
}

const image = (spec: Omit<Extract<FixtureSpec, { kind: "image" }>, "kind">): FixtureSpec => ({ kind: "image", ...spec });
const invalid = (spec: Omit<Extract<FixtureSpec, { kind: "invalid" }>, "kind">): FixtureSpec => ({ kind: "invalid", ...spec });
const single = (fixture: string, description: string): ScenarioSpec => ({ name: `single-${fixture}`, description, fixtures: [fixture], ops: 1, concurrency: 1, path: "upload" });

const FULL_FIXTURES: FixtureSpec[] = [
  image({ name: "jpeg-small-landscape", format: "jpeg", mimetype: "image/jpeg", width: 1024, height: 768, content: "photo", noise: 12, quality: 82, seed: 11, tags: ["small"] }),
  image({ name: "jpeg-typical-landscape", format: "jpeg", mimetype: "image/jpeg", width: 4032, height: 3024, content: "photo", noise: 18, quality: 88, seed: 12, tags: ["typical", "landscape"] }),
  image({ name: "jpeg-typical-portrait", format: "jpeg", mimetype: "image/jpeg", width: 3024, height: 4032, content: "photo", noise: 18, quality: 88, seed: 13, tags: ["typical", "portrait"] }),
  image({ name: "jpeg-near-limit", format: "jpeg", mimetype: "image/jpeg", width: 6000, height: 4000, content: "photo", noise: 40, quality: 98, targetMaxBytes: NEAR_LIMIT_BYTES, seed: 14, tags: ["near-limit", "landscape"] }),
  image({ name: "png-typical-landscape", format: "png", mimetype: "image/png", width: 1600, height: 1200, content: "photo", noise: 10, seed: 21, tags: ["typical", "landscape"] }),
  image({ name: "png-rgba-portrait", format: "png", mimetype: "image/png", width: 1200, height: 1600, content: "photo", channels: 4, noise: 8, seed: 22, tags: ["typical", "portrait", "alpha"] }),
  image({ name: "png-near-limit", format: "png", mimetype: "image/png", width: 2350, height: 1500, content: "photo", noise: 36, targetMaxBytes: NEAR_LIMIT_BYTES, seed: 23, tags: ["near-limit", "landscape"] }),
  image({ name: "webp-typical-portrait", format: "webp", mimetype: "image/webp", width: 2000, height: 3000, content: "photo", noise: 18, quality: 85, seed: 31, tags: ["typical", "portrait"] }),
  image({ name: "webp-near-limit", format: "webp", mimetype: "image/webp", width: 6000, height: 4000, content: "photo", noise: 48, quality: 100, targetMaxBytes: NEAR_LIMIT_BYTES, seed: 32, tags: ["near-limit", "landscape"] }),
  image({ name: "jpeg-stress-64mp", format: "jpeg", mimetype: "image/jpeg", width: 8000, height: 8000, content: "flat", quality: 80, tags: ["decompression-stress"] }),
  image({ name: "png-stress-144mp", format: "png", mimetype: "image/png", width: 12000, height: 12000, content: "flat", tags: ["decompression-stress"] }),
  image({ name: "png-over-pixel-limit", format: "png", mimetype: "image/png", width: 17000, height: 17000, content: "flat", tags: ["decompression-stress", "over-pixel-limit"] }),
  invalid({ name: "invalid-random-bytes", mimetype: "image/jpeg", variant: "random-bytes", sizeBytes: 512 * 1024, tags: ["invalid"] }),
  invalid({ name: "invalid-truncated-jpeg", mimetype: "image/jpeg", variant: "truncated", source: "jpeg-typical-landscape", tags: ["invalid", "corrupted"] }),
  invalid({ name: "invalid-text-as-png", mimetype: "image/png", variant: "text", tags: ["invalid"] }),
  invalid({ name: "invalid-empty", mimetype: "image/webp", variant: "empty", tags: ["invalid"] }),
  invalid({ name: "invalid-oversize", mimetype: "image/jpeg", variant: "oversize", sizeBytes: PRODUCT_PHOTO_LIMIT_BYTES + 1, tags: ["invalid", "oversize"] }),
  invalid({ name: "invalid-gif-mime", mimetype: "image/gif", variant: "mime-mismatch", source: "png-typical-landscape", tags: ["invalid", "mime"] }),
  invalid({ name: "mime-mismatch-png-as-jpeg", mimetype: "image/jpeg", variant: "mime-mismatch", source: "png-typical-landscape", tags: ["mime"] }),
];

const SINGLE_FIXTURES = FULL_FIXTURES.map((spec) => spec.name);
const MIXED_TYPICAL = ["jpeg-typical-landscape", "jpeg-typical-portrait", "png-typical-landscape", "webp-typical-portrait", "jpeg-near-limit", "png-rgba-portrait"];

const FULL_SCENARIOS: ScenarioSpec[] = [
  ...SINGLE_FIXTURES.map((name) => single(name, "One upload in a fresh process")),
  { name: "sequential-12-mixed", description: "12 sequential uploads mixing formats and sizes (admin UI behaviour)", fixtures: MIXED_TYPICAL, ops: 12, concurrency: 1, path: "upload" },
  { name: "sequential-12-near-limit", description: "12 sequential near-10 MiB uploads across JPEG/PNG/WebP", fixtures: ["jpeg-near-limit", "png-near-limit", "webp-near-limit"], ops: 12, concurrency: 1, path: "upload" },
  ...[1, 2, 4].map((concurrency): ScenarioSpec => ({ name: `concurrent-${concurrency}-jpeg-near-limit`, description: `8 near-10 MiB JPEG uploads, ${concurrency} in flight`, fixtures: ["jpeg-near-limit"], ops: 8, concurrency, path: "upload" })),
  ...[1, 2, 4].map((concurrency): ScenarioSpec => ({ name: `concurrent-${concurrency}-png-near-limit`, description: `8 near-10 MiB PNG uploads, ${concurrency} in flight`, fixtures: ["png-near-limit"], ops: 8, concurrency, path: "upload" })),
  ...[1, 2, 4].map((concurrency): ScenarioSpec => ({ name: `concurrent-${concurrency}-mixed`, description: `12 mixed uploads, ${concurrency} in flight`, fixtures: MIXED_TYPICAL, ops: 12, concurrency, path: "upload" })),
  { name: "concurrent-4-png-stress-144mp", description: "4 decompression-stress PNGs in flight", fixtures: ["png-stress-144mp"], ops: 4, concurrency: 4, path: "upload" },
  { name: "deterministic-jpeg-near-limit", description: "AI intake finalization path (writeDeterministicProductPhoto), unique keys", fixtures: ["jpeg-near-limit"], ops: 4, concurrency: 1, path: "deterministic" },
  { name: "deterministic-retry-jpeg-near-limit", description: "AI intake finalization idempotent retry: same key 4 times (read + compare)", fixtures: ["jpeg-near-limit"], ops: 4, concurrency: 1, path: "deterministic", reuseDestination: true },
  { name: "variant-concurrent-4-jpeg-near-limit-sharp-concurrency-1", description: "NOT production config: sharp.concurrency(1)", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 4, path: "upload", sharpConcurrency: 1 },
  { name: "variant-concurrent-4-jpeg-near-limit-sharp-cache-off", description: "NOT production config: sharp.cache(false)", fixtures: ["jpeg-near-limit"], ops: 8, concurrency: 4, path: "upload", sharpCacheDisabled: true },
];

const QUICK_FIXTURES: FixtureSpec[] = [
  image({ name: "jpeg-tiny-landscape", format: "jpeg", mimetype: "image/jpeg", width: 96, height: 64, content: "photo", noise: 20, quality: 90, seed: 1, tags: ["small", "landscape"] }),
  image({ name: "png-tiny-portrait", format: "png", mimetype: "image/png", width: 48, height: 72, content: "photo", channels: 4, noise: 20, seed: 2, tags: ["small", "portrait"] }),
  image({ name: "webp-tiny-target", format: "webp", mimetype: "image/webp", width: 120, height: 80, content: "photo", noise: 60, quality: 100, targetMaxBytes: 4096, seed: 3, tags: ["small"] }),
  invalid({ name: "invalid-truncated-jpeg", mimetype: "image/jpeg", variant: "truncated", source: "jpeg-tiny-landscape", tags: ["invalid"] }),
  invalid({ name: "invalid-oversize", mimetype: "image/jpeg", variant: "oversize", tags: ["invalid", "oversize"] }),
];

const QUICK_SCENARIOS: ScenarioSpec[] = [
  { name: "quick-sequential", description: "Tooling check: mixed sequential uploads incl. failures", fixtures: ["jpeg-tiny-landscape", "png-tiny-portrait", "webp-tiny-target", "invalid-truncated-jpeg", "invalid-oversize"], ops: 10, concurrency: 1, path: "upload" },
  { name: "quick-concurrent-2", description: "Tooling check: concurrency 2", fixtures: ["jpeg-tiny-landscape", "webp-tiny-target"], ops: 4, concurrency: 2, path: "upload" },
  { name: "quick-deterministic-retry", description: "Tooling check: deterministic idempotent retry", fixtures: ["png-tiny-portrait"], ops: 2, concurrency: 1, path: "deterministic", reuseDestination: true },
];

export const PROFILES: Record<BenchmarkProfile["name"], BenchmarkProfile> = {
  full: { name: "full", fixtures: FULL_FIXTURES, scenarios: FULL_SCENARIOS },
  quick: { name: "quick", fixtures: QUICK_FIXTURES, scenarios: QUICK_SCENARIOS },
};
