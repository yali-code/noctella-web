/**
 * P2-2B3D6 (#396/#403/#407): development-only shutdown gate for the five dangerous legacy
 * mutation paths (writers 1, 6, 8, 9, 10 in docs/engineering/P2-2B3D4_WRITER_ADOPTION.md).
 *
 * NOT wired into any route, worker, scheduler or outbox dispatcher. Construction requires
 * NODE_ENV=test|development, PRODUCT_PHOTO_DISK_STAGING_ENABLED=true and a disposable
 * os.tmpdir()/noctella-photo-fence-* root. It never deletes, renames or quarantines media.
 *
 * Protocol:
 * - Gate state is append-only: epochs/<n>.json written exclusively (wx + fsync), never
 *   overwritten. The highest readable epoch is current; a malformed or missing current epoch
 *   fails closed (GATE_UNAVAILABLE). Transitions are CAS on the epoch under an exclusive lock.
 * - OPEN -> DRAINING -> CLOSED; explicit reopen (rollback) to OPEN creates a new epoch, so a
 *   lease or check from an earlier epoch can never be revalidated (ABA).
 * - A legacy writer enters with a lease (inflight/<id>.json) and must call checkpoint()
 *   immediately before each filesystem mutation. Closure is refused while any lease marker
 *   exists (live or SIGKILL-retained), while dangerous outbox events are pending/processing,
 *   or when the outbox state is unknown.
 * - Dangerous outbox events (delete / temp cleanup) are parked, never acknowledged, when the
 *   gate is not OPEN.
 * Limitation (by construction): code that does not call this gate (an older binary) is not
 * stopped by it. Old instances must be stopped before DRAINING begins.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type LegacyWriterId = "W1_LEGACY_UPLOAD" | "W6_AI_CLEANUP" | "W8_OUTBOX_DELETE" | "W9_OUTBOX_TEMP_CLEANUP" | "W10_UPLOAD_ROLLBACK";
export type GateState = "OPEN" | "DRAINING" | "CLOSED";
export interface GateEpoch { epoch: number; state: GateState; reason: string; at: string }
export interface OutboxRowForDrain { id: string; event_type: string; status: string; locked_by?: string | null }
export interface DrainReport { epoch: number; state: GateState; inflight: string[]; dangerousEvents: string[]; outboxKnown: boolean; ready: boolean }

const WRITERS: readonly LegacyWriterId[] = ["W1_LEGACY_UPLOAD", "W6_AI_CLEANUP", "W8_OUTBOX_DELETE", "W9_OUTBOX_TEMP_CLEANUP", "W10_UPLOAD_ROLLBACK"];
export const DANGEROUS_OUTBOX_EVENTS = ["product_photo.delete_requested", "product_photo.cleanup_temp_requested"] as const;
const TERMINAL_STATUSES = new Set(["completed", "dead_lettered", "dead-lettered", "cancelled"]);
const fail = (code: string): never => { throw new Error(code); };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeExclusive(file: string, value: unknown): { dev: bigint; ino: bigint } {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } finally { fs.closeSync(fd); }
}

export interface LegacyWriterLease { readonly id: string; readonly writer: LegacyWriterId; readonly epoch: number; checkpoint(): void; exit(): void }

export class DevelopmentLegacyWriterGate {
  readonly #epochs: string; readonly #inflight: string; readonly #lock: string;
  constructor(root: string, private readonly lockWaitMs = 2000) {
    if (!["test", "development"].includes(process.env.NODE_ENV ?? "") || process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED !== "true") fail("PHOTO_DEVELOPMENT_LEGACY_GATE_DISABLED");
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.join(os.tmpdir(), "noctella-photo-fence-"))) fail("PHOTO_DISPOSABLE_LEGACY_GATE_REQUIRED");
    this.#epochs = path.join(resolved, "epochs"); this.#inflight = path.join(resolved, "inflight"); this.#lock = path.join(resolved, "gate.lock");
    for (const dir of [resolved, this.#epochs, this.#inflight]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PHOTO_LEGACY_GATE_UNSAFE_ROOT");
    }
  }

  /** Creates epoch 1 (OPEN) exactly once; a second call is a no-op. */
  initialize(): GateEpoch {
    return this.#locked(() => {
      if (fs.readdirSync(this.#epochs).length === 0) writeExclusive(path.join(this.#epochs, "1.json"), { epoch: 1, state: "OPEN", reason: "initialized", at: new Date().toISOString() });
      return this.current();
    });
  }

  /** Highest epoch; unreadable or malformed state fails closed. */
  current(): GateEpoch {
    const names = fs.readdirSync(this.#epochs).filter((n) => /^[1-9][0-9]{0,15}\.json$/.test(n));
    if (names.length === 0) fail("GATE_UNAVAILABLE");
    const top = Math.max(...names.map((n) => Number(n.slice(0, -5))));
    let parsed: GateEpoch;
    try { parsed = JSON.parse(fs.readFileSync(path.join(this.#epochs, `${top}.json`), "utf8")); } catch { return fail("GATE_UNAVAILABLE"); }
    if (parsed.epoch !== top || !["OPEN", "DRAINING", "CLOSED"].includes(parsed.state)) fail("GATE_UNAVAILABLE");
    return parsed;
  }

  /** CAS transition. CLOSED requires a ready drain report for the same epoch. */
  transition(expectedEpoch: number, next: GateState, reason: string, drain?: DrainReport): GateEpoch {
    return this.#locked(() => {
      const cur = this.current();
      if (cur.epoch !== expectedEpoch) fail("GATE_EPOCH_CHANGED");
      const allowed = (cur.state === "OPEN" && next === "DRAINING") || (cur.state === "DRAINING" && next === "CLOSED") || (cur.state !== "OPEN" && next === "OPEN");
      if (!allowed) fail("GATE_INVALID_TRANSITION");
      if (next === "CLOSED") {
        // The caller's report carries the DB/outbox snapshot; lease markers are re-read under the lock.
        const freshInflight = fs.readdirSync(this.#inflight);
        if (!drain || drain.epoch !== cur.epoch || !drain.ready || freshInflight.length > 0) fail("GATE_DRAIN_UNPROVEN");
      }
      const state: GateEpoch = { epoch: cur.epoch + 1, state: next, reason: String(reason).slice(0, 200), at: new Date().toISOString() };
      writeExclusive(path.join(this.#epochs, `${state.epoch}.json`), state);
      return state;
    });
  }

  enter(writer: LegacyWriterId): LegacyWriterLease {
    if (!WRITERS.includes(writer)) fail("GATE_UNKNOWN_WRITER");
    const id = randomUUID(), nonce = randomUUID();
    const file = path.join(this.#inflight, `${writer}-${id}.json`);
    const { epoch } = this.#locked(() => {
      const cur = this.current();
      if (cur.state !== "OPEN") fail("LEGACY_WRITER_GATE_CLOSED");
      const identity = writeExclusive(file, { id, writer, epoch: cur.epoch, nonce });
      return { epoch: cur.epoch, identity };
    });
    let exited = false;
    return {
      id, writer, epoch,
      // Call immediately before every filesystem mutation; any epoch change denies it.
      checkpoint: () => { if (exited) fail("LEGACY_WRITER_LEASE_EXITED"); const cur = this.current(); if (cur.epoch !== epoch || cur.state !== "OPEN") fail("LEGACY_WRITER_GATE_CLOSED"); },
      exit: () => {
        if (exited) return;
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (record.nonce !== nonce) fail("LEGACY_WRITER_LEASE_CHANGED_RETAINED");
        fs.unlinkSync(file); // own bookkeeping marker only, never media
        exited = true;
      },
    };
  }

  /** Dangerous outbox handlers may run only while OPEN; otherwise the event stays pending (parked). */
  dispatchAllowed(eventType: string): boolean {
    if (!(DANGEROUS_OUTBOX_EVENTS as readonly string[]).includes(eventType)) return true;
    try { return this.current().state === "OPEN"; } catch { return false; }
  }

  /** Measurable readiness: no lease markers (live or crash-retained) and no non-terminal dangerous events. */
  drainStatus(outbox: OutboxRowForDrain[] | null): DrainReport { return this.#drain(this.current(), outbox); }

  #drain(cur: GateEpoch, outbox: OutboxRowForDrain[] | null | undefined): DrainReport {
    const inflight = fs.readdirSync(this.#inflight).sort();
    const dangerousEvents = (outbox ?? []).filter((e) => (DANGEROUS_OUTBOX_EVENTS as readonly string[]).includes(e.event_type) && (!TERMINAL_STATUSES.has(e.status) || Boolean(e.locked_by))).map((e) => `${e.id}:${e.event_type}:${e.status}`);
    const outboxKnown = Array.isArray(outbox);
    return { epoch: cur.epoch, state: cur.state, inflight, dangerousEvents, outboxKnown, ready: cur.state === "DRAINING" && outboxKnown && inflight.length === 0 && dangerousEvents.length === 0 };
  }

  #locked<T>(work: () => T): T {
    const deadline = Date.now() + this.lockWaitMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try { fd = fs.openSync(this.#lock, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (Date.now() >= deadline) fail("GATE_BUSY"); sleep(5); }
    }
    const nonce = randomUUID();
    let written = false;
    try { fs.writeSync(fd, nonce); fs.fsyncSync(fd); written = true; return work(); }
    finally {
      fs.closeSync(fd);
      // A crashed holder leaves the lock: every caller stays GATE_BUSY until operator review.
      if (written && fs.readFileSync(this.#lock, "utf8") === nonce) fs.unlinkSync(this.#lock);
    }
  }
}
