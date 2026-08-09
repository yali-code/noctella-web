export const PRODUCT_PHOTO_BACKUP_REQUEST_TIMEOUT_MS = 900_000;

export async function requestProductPhotoBackup(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const hostPort = env.API_HOSTPORT;
  const token = env.SCHEDULER_AUTH_TOKEN;
  if (!hostPort || !token) return { ok: false, error: "API_HOSTPORT and SCHEDULER_AUTH_TOKEN are required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRODUCT_PHOTO_BACKUP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${hostPort}/api/background-jobs/product-photo-backup`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `Product photo backup responded with status ${response.status}` };
  } catch { return { ok: false, error: "Product photo backup request failed" }; }
  finally { clearTimeout(timeout); }
}

async function main() {
  const result = await requestProductPhotoBackup();
  if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
  console.log(`Product photo backup succeeded with status ${result.status}`);
}
if (require.main === module) void main();
