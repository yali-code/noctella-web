import { materializeRemoteDatabaseBackup } from "../services/databaseBackup";

export async function runDatabaseRestoreMaterializationCli(
  args: string[],
  dependencies: {
    materialize?: typeof materializeRemoteDatabaseBackup;
    output?: (value: string) => void;
    error?: (value: string) => void;
  } = {},
) {
  const [objectKey, destination] = args;
  if (!objectKey || !destination || args.length !== 2) {
    (dependencies.error ?? console.error)("A database backup object key and new recovery destination are required");
    return 1;
  }
  try {
    const result = await (dependencies.materialize ?? materializeRemoteDatabaseBackup)(objectKey, destination);
    (dependencies.output ?? console.log)(JSON.stringify({
      objectKey: result.objectKey,
      destination: result.destination,
      byteSize: result.byteSize,
      sha256: result.sha256,
      integrity: result.integrity,
    }));
    return 0;
  } catch {
    (dependencies.error ?? console.error)("Database restore candidate materialization failed");
    return 1;
  }
}

if (require.main === module) void runDatabaseRestoreMaterializationCli(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
