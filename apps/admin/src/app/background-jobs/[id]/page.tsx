export const dynamic = "force-dynamic";
import { getBackgroundJob, safeError } from "../../../lib/stockSyncJobs";
export default async function BackgroundJobDetail({ params }: { params: { id: string } }) { const job = await getBackgroundJob(params.id); return <main><h1>Background job {job.id}</h1><dl><dt>Status</dt><dd>{job.status}</dd><dt>Attempts</dt><dd>{job.attemptCount}/{job.maxAttempts}</dd><dt>Lock</dt><dd>{job.lockedBy ?? "-"} {job.lockedAt ?? ""}</dd><dt>Error</dt><dd>{safeError(job.lastError)}</dd></dl><h2>Payload</h2><pre>{job.payloadSnapshot}</pre></main>; }
