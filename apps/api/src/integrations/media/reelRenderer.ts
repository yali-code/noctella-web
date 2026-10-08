import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";

/**
 * Media Planning Agent: deterministic local Reel renderer (no AI video). Builds a vertical 9:16
 * 1080x1920 H.264/yuv420p MP4 (~8 s, 30 fps, faststart, silent) from REAL ERP photos with a slow
 * zoom per photo and crossfades. Opening hook / final frame text are burned in only when a font
 * file is configured (REEL_FONT_FILE); otherwise they remain plan metadata. Requires an ffmpeg
 * binary (FFMPEG_PATH, ffmpeg-static or `ffmpeg` on PATH) - completion is never faked: the output
 * must exist and carry an MP4 `ftyp` signature. Settings are memory-bounded for a 512 MiB instance.
 */

export const REEL_WIDTH = 1080, REEL_HEIGHT = 1920, REEL_FPS = 30, REEL_DURATION_SECONDS = 8, REEL_TRANSITION_SECONDS = 0.5;
export const REEL_X264_PARAMS = "rc-lookahead=0:sync-lookahead=0:ref=1:bframes=0";

export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<void>;
export const execRunner: CommandRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) =>
    (error ? reject(Object.assign(error, { stderr: String(stderr ?? "") })) : resolve()));
});

export interface ReelRenderInput {
  readonly photoPaths: readonly string[];
  readonly outputPath: string;
  readonly hookText?: string | null;
  readonly finalText?: string | null;
  readonly fontFile?: string | null;
  /** Overrides for tiny smoke renders only; production uses the 1080x1920 / 8 s defaults. */
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
}

/** drawtext-safe text: letters, digits and basic punctuation only (no quotes/colons/backslashes). */
export function overlayText(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} .,!?&-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 48);
  return cleaned || null;
}

export function buildFfmpegArgs(input: ReelRenderInput): string[] {
  const n = input.photoPaths.length;
  if (n === 0) throw new Error("REEL_REQUIRES_PHOTOS");
  const W = input.width ?? REEL_WIDTH, H = input.height ?? REEL_HEIGHT, D = input.durationSeconds ?? REEL_DURATION_SECONDS;
  const t = n > 1 ? Math.min(REEL_TRANSITION_SECONDS, D / (2 * n)) : 0;
  const segment = (D + (n - 1) * t) / n;
  const frames = Math.round(segment * REEL_FPS);
  // Memory safety (512 MiB API instance): FFmpeg/x264 otherwise size thread pools - and the frame
  // buffers each thread holds - by host CPU count, so decoder/filter/encoder each get one thread.
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-filter_complex_threads", "1"];
  for (const p of input.photoPaths) args.push("-threads", "1", "-i", p);
  const parts: string[] = input.photoPaths.map((_, i) =>
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `zoompan=z='min(zoom+0.0007,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${REEL_FPS},` +
    // xfade (FFmpeg 7.x) requires a declared constant frame rate on every input; setpts leaves it
    // undefined ("current rate of 1/0 is invalid"), so re-assert fps + timebase after it.
    `setsar=1,format=yuv420p,trim=duration=${segment.toFixed(3)},setpts=PTS-STARTPTS,fps=${REEL_FPS},settb=1/${REEL_FPS}[v${i}]`);
  let last = "v0";
  for (let i = 1; i < n; i += 1) {
    const out = `x${i}`;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${t}:offset=${(i * (segment - t)).toFixed(3)}[${out}]`);
    last = out;
  }
  const hook = overlayText(input.hookText), finalText = overlayText(input.finalText);
  if (input.fontFile && (hook || finalText)) {
    const font = input.fontFile.replace(/\\/g, "/").replace(/:/g, "\\:");
    const draw = (text: string, from: number, to: number, y: string) => `drawtext=fontfile='${font}':text='${text}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=${y}:enable='between(t,${from},${to})'`;
    const filters = [hook ? draw(hook, 0, 2.2, "h*0.12") : null, finalText ? draw(finalText, Math.max(0, D - 1.6), D, "h*0.80") : null].filter(Boolean);
    parts.push(`[${last}]${filters.join(",")}[final]`);
    last = "final";
  }
  args.push("-filter_complex", parts.join(";"), "-map", `[${last}]`, "-t", String(D),
    // x264 without lookahead / B-frames / extra references holds only a few frames in memory
    // (measured 1080x1920 peak ~210 MiB vs ~660 MiB with default threads + preset medium).
    "-filter_threads", "1", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-x264-params", REEL_X264_PARAMS, "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(REEL_FPS), "-movflags", "+faststart", "-an", input.outputPath);
  return args;
}

/** MP4/ISO-BMFF signature: bytes 4..8 are "ftyp". */
export async function isMp4File(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return bytesRead >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  } finally { await handle.close(); }
}

/**
 * FFmpeg resolution: 1) explicit FFMPEG_PATH, 2) repo-managed ffmpeg-static binary (installed by
 * npm ci, linux x64 on Render), 3) `ffmpeg` on PATH. Local overrides always win.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): { path: string; source: "FFMPEG_PATH" | "ffmpeg-static" | "PATH" } {
  const explicit = env.FFMPEG_PATH?.trim();
  if (explicit) return { path: explicit, source: "FFMPEG_PATH" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled: unknown = require("ffmpeg-static");
    if (typeof bundled === "string" && existsSync(bundled)) return { path: bundled, source: "ffmpeg-static" };
  } catch { /* not installed - fall through to PATH */ }
  return { path: "ffmpeg", source: "PATH" };
}

export function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveFfmpeg(env).path;
}

export async function isFfmpegAvailable(env: NodeJS.ProcessEnv = process.env, run: CommandRunner = execRunner): Promise<boolean> {
  try { await run(resolveFfmpegPath(env), ["-hide_banner", "-version"], 10_000); return true; } catch { return false; }
}

/** Bounded, single-line FFmpeg stderr tail (args contain only local paths/overlay text - no secrets). */
function renderFailureDetail(error: unknown): string {
  const raw = (error as { stderr?: unknown })?.stderr;
  const stderr = typeof raw === "string" ? raw : "";
  const tail = stderr.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(-600);
  return tail ? `: ${tail}` : "";
}

/** Sibling work file (never matches the public Reel name pattern, so it can never be served). */
export const partialReelPath = (outputPath: string) => outputPath.replace(/(\.mp4)?$/i, ".partial.mp4");

/**
 * FFmpeg writes to a partial file that is validated (exists, non-empty, MP4 signature) and only then
 * atomically renamed onto the final name; a stale or failed partial is always removed.
 */
export async function renderReel(input: ReelRenderInput, options: { env?: NodeJS.ProcessEnv; run?: CommandRunner } = {}): Promise<{ path: string; bytes: number }> {
  const run = options.run ?? execRunner;
  const partial = partialReelPath(input.outputPath);
  await rm(partial, { force: true });
  try {
    try {
      await run(resolveFfmpegPath(options.env), buildFfmpegArgs({ ...input, outputPath: partial }), 180_000);
    } catch (error) {
      throw new Error(`REEL_RENDER_FAILED${renderFailureDetail(error)}`);
    }
    const info = await stat(partial).catch(() => null);
    if (!info || info.size === 0 || !(await isMp4File(partial))) throw new Error("REEL_RENDER_INVALID_OUTPUT");
    await rename(partial, input.outputPath);
    return { path: input.outputPath, bytes: info.size };
  } finally {
    await rm(partial, { force: true });
  }
}
