export const dynamic = "force-dynamic";
import { canCancelJob, canRetryJob, getBackgroundJob, safeError } from "../../../lib/stockSyncJobs";
import { JobActions } from "./JobActions";

export default async function BackgroundJobDetail({ params }: { params: { id: string } }) {
  let job: Awaited<ReturnType<typeof getBackgroundJob>> | null = null;
  let error: string | null = null;
  try { job = await getBackgroundJob(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load background job"; }
  if (error || !job) return <main><h1>Background job</h1><p role="alert">{error ?? "Background job not found"}</p></main>;
  return (
    <main>
      <h1>Background job {job.id}</h1>
      <dl>
        <dt>Status</dt><dd>{job.status}</dd>
        <dt>Attempts</dt><dd>{job.attemptCount}/{job.maxAttempts}</dd>
        <dt>Lock</dt><dd>{job.lockedBy ?? "-"} {job.lockedAt ?? ""}</dd>
        <dt>Error</dt><dd>{safeError(job.lastError)}</dd>
      </dl>
      <h2>Payload</h2>
      <pre>{job.payloadSnapshot}</pre>
      <JobActions jobId={job.id} canRetry={canRetryJob(job)} canCancel={canCancelJob(job)} />
    </main>
  );
}
