export const DATABASE_BACKUP_REQUEST_TIMEOUT_MS = 900_000;

export async function requestDatabaseBackup(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DATABASE_BACKUP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${hostPort}/api/background-jobs/database-backup`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `Database backup responded with status ${response.status}` };
  } catch { return { ok: false, error: "Database backup request failed" }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const result = await requestDatabaseBackup();
  if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
  console.log(`Database backup succeeded with status ${result.status}`);
}
if (require.main === module) void main();
