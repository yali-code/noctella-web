import {verifyRemoteDatabaseBackup} from "../services/databaseBackup";
import {
  assertMetaE07StagingEnvironment, validateMetaE07StagingPreflight, type E07PreflightEnv,
} from "./preflightMetaPaidStageWrite";

/**
 * ADS-009O: independent read-only staging R2 backup audit.
 * No fake campaign ID, Meta token, read/write approval or ERP DB is required.
 * R2 verification downloads into a disposable temporary workspace, verifies
 * size, SHA-256, SQLite integrity and then deletes the temporary copy.
 */
export async function verifyMetaE07BackupOnly(
  env:E07PreflightEnv=process.env,
  verify:typeof verifyRemoteDatabaseBackup=verifyRemoteDatabaseBackup,
  now=new Date(),
) {
  assertMetaE07StagingEnvironment(env);
  const key=env.NOCTELLA_E07_STAGING_BACKUP_KEY;
  if(!key || !/^database-backups\/noctella-sqlite-[A-Za-z0-9-]+\.sqlite$/.test(key)) {
    throw new Error("E07 backup audit denied: backup key missing or malformed");
  }
  const result=await verify(key,env as NodeJS.ProcessEnv);
  const age=now.getTime()-Date.parse(result.createdAt);
  if(result.objectKey!==key || result.integrity!=="ok" ||
     !Number.isFinite(age) || age<0 || age>36*60*60*1000 ||
     !/^[a-f0-9]{64}$/.test(result.sha256) ||
     !Number.isSafeInteger(result.byteSize) || result.byteSize<=0){
    throw new Error("E07 backup audit denied: integrity or freshness check failed");
  }
  return {
    mode:"STAGING_E07_R2_BACKUP_AUDIT" as const,
    objectKey:key,
    backupIntegrity:"ok" as const,
    backupFreshness:"WITHIN_36H" as const,
    backupByteSize:result.byteSize,
    backupSha256:result.sha256,
    backupVerifiedAt:now.toISOString(),
    providerCalled:false as const,
    databaseWritePerformed:false as const,
    snapshotWritePerformed:false as const,
    campaignModified:false as const,
    spendAuthorized:false as const,
  };
}

/** ADS-009L: full Meta-specific E07 backup gate remains strict and unchanged. */
export async function verifyMetaE07BackupPreflight(
  env:E07PreflightEnv=process.env,
  verify:typeof verifyRemoteDatabaseBackup=verifyRemoteDatabaseBackup,
  now=new Date(),
) {
  const scope=validateMetaE07StagingPreflight(env,now);
  const audit=await verifyMetaE07BackupOnly(env,verify,now);
  return {...scope,
    backupIntegrity:audit.backupIntegrity,
    backupFreshness:audit.backupFreshness,
    backupByteSize:audit.backupByteSize,
    backupSha256:audit.backupSha256,
    backupVerifiedAt:audit.backupVerifiedAt,
    snapshotWritePerformed:false as const,
  };
}
async function main() {
  try { console.log(JSON.stringify(await verifyMetaE07BackupPreflight(),null,2)); }
  catch { console.error("E07 backup preflight denied or failed. No snapshot writes were attempted.");process.exitCode=1; }
}
if(require.main===module)void main();
