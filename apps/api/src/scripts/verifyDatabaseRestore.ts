import { verifyRemoteDatabaseBackup } from "../services/databaseBackup";

async function main() {
  const objectKey = process.argv[2];
  if (!objectKey) { console.error("A database backup object key is required"); process.exitCode = 1; return; }
  try {
    const result = await verifyRemoteDatabaseBackup(objectKey);
    console.log(JSON.stringify({ objectKey: result.objectKey, byteSize: result.byteSize, sha256: result.sha256, integrity: result.integrity }));
  } catch { console.error("Database restore verification failed"); process.exitCode = 1; }
}
if (require.main === module) void main();
