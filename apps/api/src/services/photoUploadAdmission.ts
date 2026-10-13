/** Product-upload process singleton. Other Sharp callers are not yet integrated (P2-2B1). */
export class PhotoUploadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "PhotoUploadError"; }
}
export const capacityError = () => new PhotoUploadError(503, "PHOTO_CAPACITY_BUSY", "Photo processing capacity is busy");
export const abortedError = () => new PhotoUploadError(400, "PHOTO_UPLOAD_ABORTED", "Photo upload was interrupted");

export class PhotoUploadAdmission {
  private held = 0;
  private active = 0;
  private closed = false;
  private waiting: Array<{ start: () => void; reject: () => void }> = [];
  constructor(private readonly options = { active: 1, waiters: 2, waitMs: 5000, alarmMs: 60000 }) {}
  snapshot() { return { held: this.held, active: this.active, waiting: this.waiting.length, closed: this.closed }; }
  close() { this.closed = true; for (const job of this.waiting.splice(0)) job.reject(); }
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
            this.waiting = this.waiting.filter((item) => item !== job);
          };
          const abort = () => { remove(); reject(abortedError()); };
          const job = {
            reject: () => { remove(); reject(capacityError()); },
            start: () => {
              remove();
              if (this.closed) { reject(capacityError()); return; }
              if (signal.aborted) { reject(abortedError()); return; }
              running = true; this.active++;
              // Native work is not released on timeout/abort until its promise physically settles.
              const alarm = setTimeout(() => this.close(), this.options.alarmMs);
              const finish = () => {
                clearTimeout(alarm); running = false; this.active--;
                if (!this.closed) this.waiting.shift()?.start();
              };
              Promise.resolve().then(work).then(
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
export const productPhotoAdmission = new PhotoUploadAdmission();
