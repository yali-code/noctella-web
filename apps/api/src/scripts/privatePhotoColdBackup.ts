/** Explicit owner-operated cold evidence export. No runtime DB import, env discovery, network or restore/replay. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { capturePrivatePhotoColdBackup, verifyPrivatePhotoColdBundle, snapshotPrivatePhotoColdDatabase, type ColdBackupRequest } from "../use-cases/private-photo-backup/useCases";

async function requestFile(file: string): Promise<ColdBackupRequest> {
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("INVALID_OPERATOR_REQUEST");
    const buffer = Buffer.alloc(64 * 1024 + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > 64 * 1024) throw new Error("INVALID_OPERATOR_REQUEST");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally { await handle.close(); }
}

export async function runPrivatePhotoColdBackupCommand(args: string[]) {
  if (args.length === 3 && args[0] === "snapshot") return snapshotPrivatePhotoColdDatabase(args[1], args[2]);
  if (args.length === 2 && args[0] === "capture") return capturePrivatePhotoColdBackup(await requestFile(args[1]));
  if (args.length === 3 && args[0] === "verify") return verifyPrivatePhotoColdBundle(args[1], args[2]);
  throw new Error("Usage: privatePhotoColdBackup snapshot <cold-source.sqlite> <new-snapshot.sqlite> | capture <operator-request.json> | verify <bundle-directory> <expected-manifest-sha256>");
}

if (require.main === module) {
  runPrivatePhotoColdBackupCommand(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
    // Do not print source paths, DB records, credentials or raw driver errors.
    console.error("Cold private-photo evidence operation failed; preserve partial output and review source/destination prerequisites. No replay is authorized.");
    process.exitCode = 1;
  });
}
