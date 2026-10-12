import {verifyRemoteDatabaseBackup} from "../services/databaseBackup";
import {validateMetaE07StagingPreflight,type E07PreflightEnv} from "./preflightMetaPaidStageWrite";

/** ADS-009L: read-only R2 integrity gate; does not open ERP DB, contact Meta or persist evidence. */
export async function verifyMetaE07BackupPreflight(
  env:E07PreflightEnv=process.env,
  verify:typeof verifyRemoteDatabaseBackup=verifyRemoteDatabaseBackup,
  now=new Date(),
) {
  const scope=validateMetaE07StagingPreflight(env,now);
  const key=env.NOCTELLA_E07_STAGING_BACKUP_KEY;
  if(!key || !/^database-backups\/noctella-sqlite-[A-Za-z0-9-]+\.sqlite$/.test(key)) {
    throw new Error("E07 backup preflight denied: staged backup key missing or malformed");
  }
  const result=await verify(key,env as NodeJS.ProcessEnv);
  const age=now.getTime()-Date.parse(result.createdAt);
  if(result.objectKey!==key || result.integrity!=="ok" ||
     !Number.isFinite(age) || age<0 || age>36*60*60*1000 ||
     !/^[a-f0-9]{64}$/.test(result.sha256) ||
     !Number.isSafeInteger(result.byteSize) || result.byteSize<=0) {
    throw new Error("E07 backup preflight denied: integrity or freshness check failed");
  }
  return {...scope,backupIntegrity:"ok" as const,backupFreshness:"WITHIN_36H" as const,
    backupByteSize:result.byteSize,backupSha256:result.sha256,
    backupVerifiedAt:now.toISOString(),snapshotWritePerformed:false as const};
}
async function main() {
  try { console.log(JSON.stringify(await verifyMetaE07BackupPreflight(),null,2)); }
  catch { console.error("E07 backup preflight denied or failed. No snapshot writes were attempted.");process.exitCode=1; }
}
if(require.main===module)void main();
