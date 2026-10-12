import { verifyMetaE07BackupOnly } from "./verifyMetaE07BackupPreflight";

/**
 * Manual, read-only E07 staging backup audit.
 * Set the backup object key only for this invocation.
 * No Meta account/campaign, read/write acknowledgements or SQLite runtime.
 */
async function main() {
  try {
    const result = await verifyMetaE07BackupOnly();
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // No tokens, S3 error bodies or actual credential values leave this command.
    console.error("E07 staging R2 backup audit denied or failed. No database write or provider call was attempted.");
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
