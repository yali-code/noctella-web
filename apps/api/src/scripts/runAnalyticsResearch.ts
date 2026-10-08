export const ANALYTICS_RESEARCH_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Analytics Stage 3: scheduler entry point (mirrors runDatabaseBackup.ts) - asks the running API
 * to run the twice-monthly web research (Stage 3 PR-2). Idempotent per half-month
 * period. Not scheduled: fails closed (409) until an approved web search provider is activated.
 */
export async function requestAnalyticsResearch(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYTICS_RESEARCH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${hostPort}/api/background-jobs/analytics-research`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `Analytics research responded with status ${response.status}` };
  } catch { return { ok: false, error: "Analytics research request failed" }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const result = await requestAnalyticsResearch();
  if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
  console.log(`Analytics research succeeded with status ${result.status}`);
}
if (require.main === module) void main();
