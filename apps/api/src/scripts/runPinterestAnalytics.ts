export const PINTEREST_ANALYTICS_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Analytics Stage 3: scheduler entry point (mirrors runDatabaseBackup.ts) - asks the running API
 * to collect Pinterest analytics (Stage 3 social analytics). Idempotent per connection +
 * report day. Not scheduled: run manually after owner consent until a controlled run succeeds.
 */
export async function requestPinterestAnalytics(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PINTEREST_ANALYTICS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${hostPort}/api/background-jobs/analytics-pinterest`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `Pinterest analytics responded with status ${response.status}` };
  } catch { return { ok: false, error: "Pinterest analytics request failed" }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const result = await requestPinterestAnalytics();
  if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
  console.log(`Pinterest analytics succeeded with status ${result.status}`);
}
if (require.main === module) void main();
