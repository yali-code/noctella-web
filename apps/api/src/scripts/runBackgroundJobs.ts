/**
 * Sprint 69: invoked by Render Cron on an hourly schedule to trigger
 * POST /api/background-jobs/run on the running API service, since nothing in the API process
 * itself runs jobs on a timer (see services/backgroundJobs.ts - runDueJobs only executes when
 * called). This script makes exactly that one authenticated HTTP call and exits - it never
 * imports db/client or touches the database directly.
 */
export interface RunBackgroundJobsResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const WORKER_ID = "render-staging-cron";
const BATCH_SIZE = 10;

export async function runBackgroundJobsOnce(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<RunBackgroundJobsResult> {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) {
    return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  }

  try {
    const res = await fetchImpl(`http://${hostPort}/api/background-jobs/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workerId: WORKER_ID, batchSize: BATCH_SIZE }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Background job run responded with status ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch {
    // Never surface the raw network error - it can otherwise echo request details (including
    // the Authorization header) back in its message. Always a fixed, safe message instead.
    return { ok: false, error: "Background job run request failed" };
  }
}

async function main() {
  const result = await runBackgroundJobsOnce();
  if (!result.ok) {
    console.error(result.error ?? `Background job run failed with status ${result.status}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Background job run succeeded with status ${result.status}`);
}

if (require.main === module) {
  main();
}
