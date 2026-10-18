/**
 * #472 F2 Step 3 OFFLINE publisher process (trusted, unconfined). Receives one publish job over IPC; at every phase
 * listed in `barriers` it reports { at, detail } and waits for "go", so the parent can interleave worker actions or
 * SIGKILL it at an exact boundary. No timing sleeps.
 */
import { publish, type Phase, type PublishTarget } from "../f2s3/snapshotPublisher";

process.once("message", async (job: { target: PublishTarget; barriers: Phase[] }) => {
  try {
    const outcome = await publish(job.target, async (phase, detail) => {
      if (!job.barriers.includes(phase)) return;
      await new Promise<void>((resolve) => {
        process.once("message", (m) => { if (m === "go") resolve(); });
        process.send?.({ at: phase, detail });
      });
    });
    process.send?.({ outcome });
  } catch (error: any) {
    process.send?.({ error: String(error?.code ?? error?.message ?? error) });
  }
});
process.send?.({ ready: process.pid });
