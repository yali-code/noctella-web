export const ANALYTICS_SNAPSHOT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Analytics Phase 1G: scheduler entry point (mirrors runDatabaseBackup.ts) - asks the running API
 * to take today's idempotent internal analytics snapshot. Safe to run more than once a day: a
 * repeat for the same UTC day replays the completed run. Not wired into Render by this change.
 */
export async function requestAnalyticsSnapshot(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYTICS_SNAPSHOT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${hostPort}/api/background-jobs/analytics-snapshot`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `Analytics snapshot responded with status ${response.status}` };
  } catch { return { ok: false, error: "Analytics snapshot request failed" }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const result = await requestAnalyticsSnapshot();
  if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
  console.log(`Analytics snapshot succeeded with status ${result.status}`);
}
if (require.main === module) void main();
