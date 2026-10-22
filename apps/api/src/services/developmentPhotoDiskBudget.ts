/**
 * P2-2B3D2 (#407): development-only, fail-closed disk budget for photo writers.
 *
 * NOT wired into any route, service default, scheduler or producer. Construction
 * requires NODE_ENV=test|development, PRODUCT_PHOTO_DISK_STAGING_ENABLED=true and a
 * disposable os.tmpdir()/noctella-photo-fence-* root, exactly like the #406
 * DevelopmentPhotoStorageCapability. It never deletes, renames or quarantines media.
 *
 * Model (see docs/engineering/P2-2B3D2_PHOTO_DISK_BUDGET.md):
 *   admitted = retained private inventory (inode-deduplicated, allocated bytes)
 *            + every outstanding reservation record (live or crash-retained)
 *            + the new attempt's full conservative reservation
 *   admitted <= budgetBytes, and
 *   filesystem free bytes - outstanding reservations - new reservation >= freeSpaceFloorBytes
 *   (and the same for inodes where the filesystem reports them).
 * All-or-nothing: an attempt is admitted with its whole reservation or rejected.
 * Double counting (bytes already written by a live reservation are counted in both
 * the inventory and its reservation) is deliberate and only ever conservative.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MiB = 1024 * 1024;

export interface PhotoDiskProfile {
  readonly name: string;
  /** Encoded input copies written to disk, each up to inputBytes. */
  readonly inputCopies: number;
  readonly inputBytes: number;
  /** Distinct output inodes (raw + sealed); canonical hardlinks add none. */
  readonly outputInodes: number;
  readonly outputCapBytes: number;
  /** Files that are not payload (markers, reservation/budget records). */
  readonly metadataFiles: number;
  readonly directories: number;
}

/**
 * Inode sets measured on the actual code paths (scripts/photo-disk-budget/measure.cjs):
 * - b1: request input + main + thumb; canonical publication is a hardlink.
 *   The on-disk input can reach 10 MiB + 1 byte (Multer's max+1 sentinel) before rejection.
 * - d1 product: capability work input + main + thumb (raw entries are hardlinks) + two sealed copies.
 * - d1 product via HTTP: additionally the HTTP ingress input, which the capability re-writes from a Buffer.
 * - d1 deterministic: raw main + thumb + two sealed copies; the AI source is already counted where it lives.
 */
export const PHOTO_DISK_PROFILES = {
  b1StagedHttp: { name: "b1-staged-http", inputCopies: 1, inputBytes: 10 * MiB + 1, outputInodes: 2, outputCapBytes: 16 * MiB, metadataFiles: 0, directories: 1 },
  d1CapabilityProduct: { name: "d1-capability-product", inputCopies: 1, inputBytes: 10 * MiB, outputInodes: 4, outputCapBytes: 16 * MiB, metadataFiles: 1, directories: 7 },
  d1CapabilityProductViaHttp: { name: "d1-capability-product-via-http", inputCopies: 2, inputBytes: 10 * MiB + 1, outputInodes: 4, outputCapBytes: 16 * MiB, metadataFiles: 1, directories: 8 },
  d1CapabilityDeterministic: { name: "d1-capability-deterministic", inputCopies: 0, inputBytes: 0, outputInodes: 4, outputCapBytes: 16 * MiB, metadataFiles: 1, directories: 7 },
} as const satisfies Record<string, PhotoDiskProfile>;

/** Per-file allocation is rounded up to whole blocks; directories and metadata files take at least one block. */
export function attemptReservation(profile: PhotoDiskProfile, blockBytes = 4096): { bytes: number; inodes: number } {
  if (!Number.isSafeInteger(blockBytes) || blockBytes < 512) throw new Error("PHOTO_DISK_INVALID_BLOCK_SIZE");
  const round = (bytes: number) => (bytes <= 0 ? 0 : Math.ceil(bytes / blockBytes) * blockBytes);
  const bytes = profile.inputCopies * round(profile.inputBytes)
    + profile.outputInodes * round(profile.outputCapBytes)
    + (profile.metadataFiles + 1) * blockBytes // +1: this budget's own reservation record
    + profile.directories * blockBytes;
  return { bytes, inodes: profile.inputCopies + profile.outputInodes + profile.metadataFiles + 1 + profile.directories };
}

export interface DiskInventory { bytes: number; inodes: number; entries: number }

/**
 * Inode-deduplicated inventory. POSIX: st_blocks * 512 (real allocation, includes
 * sparse/extent effects). Windows: size rounded up to the cluster (st_blocks is
 * not reported). Directories count one block each at minimum. Symlinks and
 * special files are refused (fail closed), never followed.
 */
export function measurePhotoInventory(roots: readonly string[], blockBytes: number, maxEntries = 20_000): DiskInventory {
  const seen = new Set<string>();
  let bytes = 0, inodes = 0, entries = 0;
  const walk = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (++entries > maxEntries) throw new Error("PHOTO_DISK_INVENTORY_TOO_LARGE");
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error("PHOTO_DISK_INVENTORY_UNSAFE");
      const key = `${stat.dev}:${stat.ino}`;
      if (!seen.has(key)) {
        seen.add(key); inodes++;
        const allocated = process.platform === "win32" || stat.blocks === undefined ? 0 : Number(stat.blocks) * 512;
        const rounded = stat.isDirectory() ? blockBytes : Math.ceil(Number(stat.size) / blockBytes) * blockBytes;
        bytes += Math.max(allocated, rounded);
      }
      if (stat.isDirectory()) walk(file);
    }
  };
  for (const root of roots) walk(path.resolve(root));
  return { bytes, inodes, entries };
}

export interface FilesystemSpace { blockBytes: number; freeBytes: number; freeInodes: number | null }
export function readFilesystemSpace(root: string): FilesystemSpace {
  const stat = fs.statfsSync(root);
  const blockBytes = Number(stat.bsize);
  if (!Number.isSafeInteger(blockBytes) || blockBytes <= 0) throw new Error("PHOTO_DISK_STATFS_UNAVAILABLE");
  // Windows reports files/ffree as 0: inode capacity is not exposed, so it is not asserted there.
  return { blockBytes, freeBytes: Number(stat.bavail) * blockBytes, freeInodes: Number(stat.files) > 0 ? Number(stat.ffree) : null };
}

export interface DevelopmentPhotoDiskBudgetOptions {
  /** Private, disposable directory holding this budget's lock, records and closed marker. */
  budgetRoot: string;
  /** Private roots whose retained bytes count against the budget (generation-private/staging trees). */
  accountedRoots: string[];
  budgetBytes: number;
  freeSpaceFloorBytes: number;
  freeInodeFloor?: number;
  lockWaitMs?: number;
  space?: (root: string) => FilesystemSpace;
  inventory?: (roots: readonly string[], blockBytes: number) => DiskInventory;
}

interface ReservationRecord { id: string; nonce: string; profile: string; label: string; bytes: number; inodes: number }
export interface PhotoDiskReservation { readonly id: string; readonly bytes: number; readonly inodes: number; release(): void }
export interface PhotoDiskBudgetSnapshot { retainedBytes: number; reservedBytes: number; reservations: number; budgetBytes: number; freeBytes: number; freeInodes: number | null; closed: boolean }

const fail = (code: string): never => { throw new Error(code); };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ID = /^[a-zA-Z0-9-]{1,80}$/;

/** Cross-process ledger: every cooperating writer process must use the same budgetRoot. */
export class DevelopmentPhotoDiskBudget {
  readonly #root: string; readonly #records: string; readonly #lock: string; readonly #closed: string;
  readonly #options: Required<Omit<DevelopmentPhotoDiskBudgetOptions, "freeInodeFloor">> & { freeInodeFloor: number };

  constructor(options: DevelopmentPhotoDiskBudgetOptions) {
    if (!["test", "development"].includes(process.env.NODE_ENV ?? "") || process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED !== "true") fail("PHOTO_DEVELOPMENT_DISK_BUDGET_DISABLED");
    const root = path.resolve(options.budgetRoot);
    if (!root.startsWith(path.join(os.tmpdir(), "noctella-photo-fence-"))) fail("PHOTO_DISPOSABLE_DISK_BUDGET_REQUIRED");
    for (const value of [options.budgetBytes, options.freeSpaceFloorBytes]) if (!Number.isSafeInteger(value) || value < 0) fail("PHOTO_DISK_INVALID_LIMIT");
    this.#root = root; this.#records = path.join(root, "reservations"); this.#lock = path.join(root, "ledger.lock"); this.#closed = path.join(root, "closed.json");
    this.#options = { lockWaitMs: 2000, space: readFilesystemSpace, inventory: measurePhotoInventory, freeInodeFloor: 0, ...options, accountedRoots: options.accountedRoots.map((r) => path.resolve(r)), budgetRoot: root };
    for (const dir of [root, this.#records]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) fail("PHOTO_DISK_UNSAFE_ROOT");
    }
  }

  /** Reserves the whole conservative attempt footprint or throws; never a partial admission. */
  reserve(profile: PhotoDiskProfile, label: string): PhotoDiskReservation {
    if (!ID.test(label)) fail("PHOTO_DISK_INVALID_LABEL");
    return this.#locked(() => {
      const state = this.#state();
      const need = attemptReservation(profile, state.space.blockBytes);
      if (state.retained.bytes + state.reservedBytes + need.bytes > this.#options.budgetBytes) fail("PHOTO_DISK_BUDGET_EXHAUSTED");
      if (state.space.freeBytes - state.reservedBytes - need.bytes < this.#options.freeSpaceFloorBytes) fail("PHOTO_DISK_FREE_SPACE_FLOOR");
      if (state.space.freeInodes !== null && state.space.freeInodes - state.reservedInodes - need.inodes < this.#options.freeInodeFloor) fail("PHOTO_DISK_FREE_INODE_FLOOR");
      const record: ReservationRecord = { id: randomUUID(), nonce: randomUUID(), profile: profile.name, label, bytes: need.bytes, inodes: need.inodes };
      const file = path.join(this.#records, `${record.id}.json`);
      const identity = this.#writeExclusive(file, record);
      let released = false;
      return {
        id: record.id, bytes: record.bytes, inodes: record.inodes,
        release: () => {
          if (released) return;
          this.#locked(() => this.#removeOwned(file, identity, record));
          released = true;
        },
      };
    });
  }

  /**
   * Persistently closes admission for every process sharing this budget (ENOSPC,
   * unknown write outcome, unsafe inventory). There is no reopen API: an operator
   * must review inventory and records before removing closed.json.
   */
  close(reason: string): void {
    try { this.#writeExclusive(this.#closed, { reason: String(reason).slice(0, 200), at: new Date().toISOString() }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }

  snapshot(): PhotoDiskBudgetSnapshot {
    return this.#locked(() => {
      const state = this.#state(false);
      return { retainedBytes: state.retained.bytes, reservedBytes: state.reservedBytes, reservations: state.reservations, budgetBytes: this.#options.budgetBytes, freeBytes: state.space.freeBytes, freeInodes: state.space.freeInodes, closed: state.closed };
    });
  }

  #state(requireOpen = true) {
    const closed = fs.existsSync(this.#closed);
    if (closed && requireOpen) fail("PHOTO_DISK_BUDGET_REVIEW_REQUIRED");
    let space: FilesystemSpace, retained: DiskInventory;
    try {
      space = this.#options.space(this.#root);
      retained = this.#options.inventory(this.#options.accountedRoots, space.blockBytes);
    } catch (error) {
      const code = (error as Error).message;
      throw new Error(/^PHOTO_DISK_/.test(code) ? code : "PHOTO_DISK_ACCOUNTING_UNAVAILABLE");
    }
    let reservedBytes = 0, reservedInodes = 0, reservations = 0;
    for (const name of fs.readdirSync(this.#records)) {
      // Crash-retained and live records both count; malformed records fail closed.
      const record = this.#readRecord(path.join(this.#records, name));
      reservedBytes += record.bytes; reservedInodes += record.inodes; reservations++;
    }
    return { closed, space, retained, reservedBytes, reservedInodes, reservations };
  }

  #readRecord(file: string): ReservationRecord {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || !file.endsWith(".json")) fail("PHOTO_DISK_RECORD_UNSAFE");
    let record: ReservationRecord;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fail("PHOTO_DISK_RECORD_UNSAFE"); }
    if (!ID.test(record.id) || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || !Number.isSafeInteger(record.inodes) || record.inodes <= 0) fail("PHOTO_DISK_RECORD_UNSAFE");
    return record;
  }

  #writeExclusive(file: string, value: unknown): { dev: bigint; ino: bigint } {
    const fd = fs.openSync(file, "wx", 0o600);
    let complete = false;
    try {
      const bytes = Buffer.from(JSON.stringify(value));
      let offset = 0;
      while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, bytes.length - offset, null); if (n <= 0) fail("PHOTO_DISK_RECORD_WRITE_FAILED"); offset += n; }
      fs.fsyncSync(fd);
      complete = true;
      const stat = fs.fstatSync(fd, { bigint: true });
      return { dev: stat.dev, ino: stat.ino };
    } finally {
      fs.closeSync(fd);
      // An incomplete record is retained: it either parses (counted) or fails closed as malformed.
      if (!complete) this.close("reservation record write failed");
    }
  }

  #removeOwned(file: string, identity: { dev: bigint; ino: bigint }, record: ReservationRecord) {
    const stat = fs.lstatSync(file, { bigint: true });
    const current = this.#readRecord(file);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || current.nonce !== record.nonce) fail("PHOTO_DISK_RECORD_CHANGED_RETAINED");
    fs.unlinkSync(file);
  }

  /**
   * Exclusive cross-process section (wx lock file with a nonce, no PID/age grant).
   * A live holder causes a bounded wait then PHOTO_DISK_BUDGET_BUSY; a crashed holder
   * leaves the lock and therefore keeps every process BUSY until operator review.
   */
  #locked<T>(work: () => T): T {
    const deadline = Date.now() + this.#options.lockWaitMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try { fd = fs.openSync(this.#lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) fail("PHOTO_DISK_BUDGET_BUSY");
        sleep(5);
      }
    }
    const nonce = randomUUID();
    let initialized = false;
    try {
      fs.writeSync(fd, nonce); fs.fsyncSync(fd); initialized = true;
      return work();
    } finally {
      const owned = fs.fstatSync(fd, { bigint: true });
      fs.closeSync(fd);
      if (initialized) {
        const current = fs.lstatSync(this.#lock, { bigint: true });
        if (current.dev !== owned.dev || current.ino !== owned.ino || fs.readFileSync(this.#lock, "utf8") !== nonce) fail("PHOTO_DISK_LOCK_CHANGED_RETAINED");
        fs.unlinkSync(this.#lock);
      }
    }
  }
}
