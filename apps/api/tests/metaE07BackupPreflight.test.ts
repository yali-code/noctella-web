// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {verifyMetaE07BackupPreflight} from "../src/scripts/verifyMetaE07BackupPreflight";
import type {verifyRemoteDatabaseBackup} from "../src/services/databaseBackup";
const key="database-backups/noctella-sqlite-20261012T030030974Z-18ab73d08772ce52.sqlite";
const env={
RENDER_SERVICE_NAME:"noctella-staging-api",DATABASE_DRIVER:"sqlite",
DATABASE_URL:"/var/data/noctella.sqlite",DATABASE_BACKUP_S3_BUCKET:"noctella-staging-db-backups",
DATABASE_BACKUP_S3_PREFIX:"database-backups",NOCTELLA_PAID_ADS_PROVIDER:"meta",
NOCTELLA_PAID_ADS_PREVIEW_ACK:"I_AUTHORIZE_PAID_READ_ONLY",
NOCTELLA_PAID_ADS_STAGE_WRITE_ACK:"I_AUTHORIZE_STAGING_SNAPSHOT_WRITE",
NOCTELLA_META_AD_ACCOUNT_ID:"3095361257478763",NOCTELLA_PAID_ADS_CAMPAIGN_ID:"12345678901",
NOCTELLA_PAID_ADS_START_DATE:"2026-10-01",NOCTELLA_PAID_ADS_END_DATE:"2026-10-02",
NOCTELLA_E07_STAGING_BACKUP_KEY:key
};
const now=new Date("2026-10-12T12:00:00Z");
const artifact={objectKey:key,integrity:"ok" as const,byteSize:2514944,
sha256:"18ab73d08772ce5218a9ccfdbafd478088ce34df6f3a940ec6ece84d44c1ebb1",
createdAt:"2026-10-12T03:00:30Z"};
const fake=(v=artifact)=>vi.fn(async (_key:string,_env?:NodeJS.ProcessEnv)=>v) as unknown as typeof verifyRemoteDatabaseBackup;
describe("ADS-009L R2 backup E07 preflight (read-only)",()=>{
it("valid staging preflight verifies R2 before returning readiness",async()=>{
 const verify=fake();
 const result=await verifyMetaE07BackupPreflight(env,verify,now);
 expect(result.backupIntegrity).toBe("ok");
 expect(result.snapshotWritePerformed).toBe(false);
 expect(result.providerCalled).toBe(false);
 expect(verify).toHaveBeenCalledOnce();
});
it("rejects production identity and never contacts R2",async()=>{
 const verify=fake();
 await expect(verifyMetaE07BackupPreflight({...env,RENDER_SERVICE_NAME:"noctella-production-api"},verify,now)).rejects.toThrow("denied");
 expect(verify).not.toHaveBeenCalled();
});
it("rejects missing/malformed R2 key before network request",async()=>{
 const verify=fake();
 await expect(verifyMetaE07BackupPreflight({...env,NOCTELLA_E07_STAGING_BACKUP_KEY:"../production.sqlite"},verify,now)).rejects.toThrow("denied");
 expect(verify).not.toHaveBeenCalled();
});
it("rejects stale/future, corrupted or mismatched backup evidence",async()=>{
 for(const patch of [{createdAt:"2026-10-10T00:00:00Z"},{createdAt:"2026-10-13T00:00:00Z"},
 {sha256:"invalid"},{byteSize:0},{objectKey:"database-backups/other.sqlite"}]){
  await expect(verifyMetaE07BackupPreflight(env,fake({...artifact,...patch}),now)).rejects.toThrow("denied");
 }
});
});
