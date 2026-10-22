import { afterEach, expect, it, vi } from "vitest";
import { PhotoUploadAdmission, imageProcessingAdmission, productPhotoAdmission, runImageOperation } from "../src/services/photoUploadAdmission";
afterEach(() => { vi.unstubAllEnvs(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function tick() { await new Promise(r => setTimeout(r, 0)); }
it("has one singleton and acquires before reads with bounded FIFO roots", async () => {
  expect(productPhotoAdmission).toBe(imageProcessingAdmission);
  const gate = new PhotoUploadAdmission(), hold = deferred(), reads: number[] = [];
  const jobs = [0,1,2].map(i => gate.scope(async () => { reads.push(i); if (!i) await hold.promise; }));
  await tick(); expect(reads).toEqual([0]);
  await expect(gate.scope(async () => { reads.push(3); })).rejects.toMatchObject({ code: "PHOTO_CAPACITY_BUSY" });
  hold.resolve(); await Promise.all(jobs);
  expect(reads).toEqual([0,1,2]); expect(gate.snapshot()).toMatchObject({ active: 0, held: 0 });
});
it("serializes concurrent leaves within an orchestration scope and bounds its forks", async () => {
  const gate = new PhotoUploadAdmission(), hold = deferred(), order: number[] = [];
  await gate.scope(async () => {
    const jobs = [0,1,2].map(i => gate.operation(async () => { order.push(i); if (!i) await hold.promise; }));
    await tick(); expect(order).toEqual([0]); expect(gate.snapshot()).toMatchObject({ held: 3, active: 1, waiting: 2 });
    await expect(gate.operation(async () => {})).rejects.toMatchObject({ code: "PHOTO_CAPACITY_BUSY" });
    hold.resolve(); await Promise.all(jobs);
  });
  expect(order).toEqual([0,1,2]); expect(gate.snapshot().held).toBe(0);
});
it("rejects accidental nested leaf APIs instead of deadlocking", async () => {
  const gate = new PhotoUploadAdmission();
  await expect(gate.operation(() => gate.operation(async () => {}))).rejects.toMatchObject({ code: "IMAGE_ADMISSION_NESTED" });
  expect(gate.snapshot()).toMatchObject({ held: 0, active: 0 });
  await expect(gate.operation(async () => 7)).resolves.toBe(7);
});
it("keeps capacity until detached native work settles even after orchestration fails", async () => {
  const gate = new PhotoUploadAdmission(), hold = deferred();
  const work = gate.scope(async () => {
    void gate.operation(async () => { await hold.promise; }).catch(() => {});
    await tick(); throw Error("orchestration failure");
  });
  let settled = false; const observed = work.catch(error => { settled = true; return error; });
  await tick(); expect(gate.snapshot().active).toBe(1); expect(settled).toBe(false);
  hold.resolve(); expect((await observed).message).toBe("orchestration failure");
  expect(gate.snapshot().held).toBe(0);
});
it("rejects stale async ownership after a completed scope", async () => {
  const gate = new PhotoUploadAdmission(), later = deferred();
  let observed!: Promise<unknown>;
  await gate.scope(async () => {
    observed = later.promise.then(() => gate.operation(async () => "must not run")).catch(error => error);
  });
  later.resolve(); expect(await observed).toMatchObject({ code: "PHOTO_CAPACITY_BUSY" });
  expect(gate.snapshot().active).toBe(0);
});
it("cancels queued roots before input reads and holds an aborted active operation", async () => {
  const gate = new PhotoUploadAdmission(), hold = deferred(), activeAbort = new AbortController(), waitingAbort = new AbortController();
  const a = gate.scope(() => gate.operation(async () => { await hold.promise; }), activeAbort.signal);
  const read = vi.fn(async () => {});
  const b = gate.scope(read, waitingAbort.signal); const rejected = expect(b).rejects.toMatchObject({ code: "PHOTO_UPLOAD_ABORTED" });
  await tick(); waitingAbort.abort(); activeAbort.abort(); await rejected;
  expect(read).not.toHaveBeenCalled(); expect(gate.snapshot()).toMatchObject({ active: 1, held: 1 });
  hold.resolve(); await a; expect(gate.snapshot().held).toBe(0);
});
it("times out queued work and closes on shutdown without releasing active native work", async () => {
  const gate = new PhotoUploadAdmission({ active: 1, waiters: 2, waitMs: 10, alarmMs: 1000 }), hold = deferred();
  const a = gate.operation(async () => { await hold.promise; });
  await expect(gate.operation(async () => {})).rejects.toMatchObject({ code: "PHOTO_QUEUE_TIMEOUT" });
  gate.close(); await expect(gate.operation(async () => {})).rejects.toMatchObject({ code: "PHOTO_CAPACITY_BUSY" });
  expect(gate.snapshot().active).toBe(1); hold.resolve(); await a;
  expect(gate.snapshot()).toMatchObject({ held: 0, active: 0, closed: true });
  await expect(new PhotoUploadAdmission().operation(async () => 1)).resolves.toBe(1);
});
it("alarm fails closed but preserves permit lifetime until physical completion", async () => {
  const gate = new PhotoUploadAdmission({ active: 1, waiters: 2, waitMs: 1000, alarmMs: 10 }), hold = deferred();
  const a = gate.operation(async () => { await hold.promise; });
  const b = gate.operation(async () => {}); const rejected = expect(b).rejects.toMatchObject({ code: "PHOTO_CAPACITY_BUSY" });
  await rejected; expect(gate.snapshot()).toMatchObject({ active: 1, closed: true });
  hold.resolve(); await a; expect(gate.snapshot().held).toBe(0);
});
it("the shared recipe requires private operation ownership when enabled",async()=>{
  vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED","true");
  const {assertImageOperationOwned}=await import("../src/services/photoUploadAdmission");
  expect(()=>assertImageOperationOwned()).toThrow("admission is required");
  await expect(runImageOperation(async()=>{assertImageOperationOwned();return "owned";})).resolves.toBe("owned");
});

it("flag OFF bypasses a closed shared controller without affecting operational callers", async () => {
  vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED", "false");
  imageProcessingAdmission.close();
  await expect(runImageOperation(async () => "legacy works")).resolves.toBe("legacy works");
  expect(imageProcessingAdmission.snapshot()).toMatchObject({ active: 0, held: 0 });
});

it("times out internal forks without releasing the native owner", async () => {
  const gate = new PhotoUploadAdmission({ active: 1, waiters: 2, waitMs: 10, alarmMs: 1000 }), hold = deferred();
  await gate.scope(async () => {
    const active = gate.operation(async () => { await hold.promise; });
    await expect(gate.operation(async () => { throw Error("must not run"); })).rejects.toMatchObject({ code: "PHOTO_QUEUE_TIMEOUT" });
    expect(gate.snapshot().active).toBe(1); hold.resolve(); await active;
  });
  expect(gate.snapshot().held).toBe(0);
});
