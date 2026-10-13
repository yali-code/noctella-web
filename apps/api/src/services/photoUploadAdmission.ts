import { AsyncLocalStorage } from "node:async_hooks";

export class PhotoUploadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message); this.name = "PhotoUploadError";
  }
}
export const capacityError = () => new PhotoUploadError(503, "PHOTO_CAPACITY_BUSY", "Photo processing capacity is busy");
export const abortedError = () => new PhotoUploadError(400, "PHOTO_UPLOAD_ABORTED", "Photo upload was interrupted");
type Owner = {
  gate: PhotoUploadAdmission; alive: boolean; accepting: boolean;
  pending: number; tail: Promise<void>; signal: AbortSignal;
};
// Only reserve().run creates ownership. There is no client-supplied lease/bypass flag.
const ownership = new AsyncLocalStorage<Owner>();
const leaf = new AsyncLocalStorage<{ owner: Owner; alive: boolean }>();

export class PhotoUploadAdmission {
  private held = 0;
  private active = 0;
  private closed = false;
  private leafWaiting = 0;
  private leafCancellations = new Set<() => void>();
  private waiting: Array<{ start: () => void; reject: () => void }> = [];
  constructor(private readonly options = { active: 1, waiters: 2, waitMs: 5000, alarmMs: 60000 }) {}
  snapshot() { return { held: this.held, active: this.active, waiting: this.waiting.length + this.leafWaiting, closed: this.closed }; }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(); for (const cancel of this.leafCancellations) cancel(); }

  /** Orchestration may read inputs and call admitted leaf APIs sequentially. */
  async scope<T>(work: () => Promise<T>, signal = new AbortController().signal): Promise<T> {
    const owner = ownership.getStore();
    if (owner?.gate === this) {
      if (!owner.alive || !owner.accepting || this.closed) throw capacityError();
      if (owner.signal.aborted || signal.aborted) throw abortedError();
      return work();
    }
    const lease = this.reserve();
    try { return await lease.run(work, signal); }
    finally { lease.release(); }
  }

  /** Leaf APIs serialize even if an orchestrator forks Promise.all. Nested leaves fail, never deadlock. */
  async operation<T>(work: () => Promise<T>): Promise<T> {
    const owner = ownership.getStore();
    if (owner?.gate !== this) return this.scope(() => this.operation(work));
    if (!owner.alive || !owner.accepting || this.closed) throw capacityError();
    if (owner.signal.aborted) throw abortedError();
    const current = leaf.getStore();
    if (current?.owner === owner && current.alive) {
      throw new PhotoUploadError(500, "IMAGE_ADMISSION_NESTED", "Nested image operation is not allowed");
    }
    if (owner.pending >= this.options.active + this.options.waiters) throw capacityError();
    const queued = owner.pending > 0;
    // Internal forks borrow the transform owner, but consume the SAME global capacity budget.
    const reservation = queued ? this.reserve() : undefined;
    owner.pending++;
    let action: (() => Promise<T>) | undefined = work;
    let canceled: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait!: (error: unknown) => void;
    const waiting = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    const abortWait = () => { canceled = abortedError(); action = undefined; rejectWait(canceled); };
    const closeWait = () => { canceled = capacityError(); action = undefined; rejectWait(canceled); };
    let counted = queued;
    if (queued) {
      this.leafWaiting++; this.leafCancellations.add(closeWait);
      owner.signal.addEventListener("abort", abortWait, { once: true });
      timer = setTimeout(() => {
        canceled = new PhotoUploadError(503, "PHOTO_QUEUE_TIMEOUT", "Photo processing queue timed out");
        action = undefined; rejectWait(canceled);
      }, this.options.waitMs);
    }
    const stopWaiting = () => { if (timer) clearTimeout(timer); owner.signal.removeEventListener("abort", abortWait); this.leafCancellations.delete(closeWait); if (counted) { counted = false; this.leafWaiting--; } };
    const task = owner.tail.then(async () => {
      stopWaiting();
      if (canceled) throw canceled;
      if (this.closed || !owner.alive) throw capacityError();
      if (owner.signal.aborted) throw abortedError();
      const execution = { owner, alive: true };
      const run = action!; action = undefined;
      try { return await leaf.run(execution, run); }
      finally { execution.alive = false; }
    });
    owner.tail = task.then(() => undefined, () => undefined);
    try { return await (queued ? Promise.race([task, waiting]) : task); }
    finally { stopWaiting(); owner.pending--; reservation?.release(); }
  }

  reserve() {
    if (this.closed || this.held >= this.options.active + this.options.waiters) throw capacityError();
    this.held++;
    let released = false, used = false, running = false;
    return {
      run: <T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> => {
        if (used || released) return Promise.reject(new Error("Photo lease already used"));
        used = true;
        return new Promise<T>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const remove = () => {
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            this.waiting = this.waiting.filter(item => item !== job);
          };
          const abort = () => { remove(); reject(abortedError()); };
          const job = {
            reject: () => { remove(); reject(capacityError()); },
            start: () => {
              remove();
              if (this.closed) { reject(capacityError()); return; }
              if (signal.aborted) { reject(abortedError()); return; }
              running = true; this.active++;
              const owner: Owner = { gate: this, alive: true, accepting: true, pending: 0, tail: Promise.resolve(), signal };
              const alarm = setTimeout(() => this.close(), this.options.alarmMs);
              const finish = () => {
                clearTimeout(alarm); owner.alive = false; running = false; this.active--;
                if (!this.closed) this.waiting.shift()?.start();
              };
              const execute = async () => {
                let value!: T, error: unknown, failed = false;
                try { value = await ownership.run(owner, work); }
                catch (err) { error = err; failed = true; }
                finally {
                  owner.accepting = false;
                  // Even accidentally detached leaf work must physically settle before release.
                  await owner.tail;
                }
                if (failed) throw error;
                return value;
              };
              Promise.resolve().then(execute).then(
                value => { finish(); resolve(value); },
                error => { finish(); reject(error); },
              );
            },
          };
          if (signal.aborted) { reject(abortedError()); return; }
          if (this.closed) { reject(capacityError()); return; }
          if (this.active < this.options.active) job.start();
          else {
            this.waiting.push(job);
            signal.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => { remove(); reject(new PhotoUploadError(503, "PHOTO_QUEUE_TIMEOUT", "Photo processing queue timed out")); }, this.options.waitMs);
          }
        });
      },
      release: () => {
        if (running) throw new Error("Cannot release active photo work");
        if (!released) { released = true; this.held--; }
      },
    };
  }
}
export const imageProcessingAdmission = new PhotoUploadAdmission();
/** Compatibility alias: exactly one singleton, not a second controller. */
export const productPhotoAdmission = imageProcessingAdmission;
export const imageAdmissionEnabled = () => process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED === "true";
export const runImageScope = <T>(work: () => Promise<T>) => imageAdmissionEnabled() ? imageProcessingAdmission.scope(work) : work();
export const runImageOperation = <T>(work: () => Promise<T>) => imageAdmissionEnabled() ? imageProcessingAdmission.operation(work) : work();


export function assertImageOperationOwned() {
  if (!imageAdmissionEnabled()) return;
  const owner = ownership.getStore(), execution = leaf.getStore();
  if (!owner?.alive || owner.gate !== imageProcessingAdmission || execution?.owner !== owner || !execution.alive) throw new PhotoUploadError(500, "IMAGE_ADMISSION_REQUIRED", "Image processing admission is required");
}
