// @vitest-environment node
import {describe,it,expect} from "vitest";
import {validateMetaE07StagingPreflight} from "../src/scripts/preflightMetaPaidStageWrite";
const good:Record<string,string>={
  RENDER_SERVICE_NAME:"noctella-staging-api", DATABASE_DRIVER:"sqlite",
  DATABASE_URL:"/var/data/noctella.sqlite",DATABASE_BACKUP_S3_BUCKET:"noctella-staging-db-backups",
  DATABASE_BACKUP_S3_PREFIX:"database-backups",NOCTELLA_PAID_ADS_PROVIDER:"meta",
  NOCTELLA_PAID_ADS_PREVIEW_ACK:"I_AUTHORIZE_PAID_READ_ONLY",
  NOCTELLA_PAID_ADS_STAGE_WRITE_ACK:"I_AUTHORIZE_STAGING_SNAPSHOT_WRITE",
  NOCTELLA_META_AD_ACCOUNT_ID:"3095361257478763",NOCTELLA_PAID_ADS_CAMPAIGN_ID:"12345678901",
  NOCTELLA_PAID_ADS_START_DATE:"2026-10-01",NOCTELLA_PAID_ADS_END_DATE:"2026-10-02"
};
describe("ADS-009K E07 manual staging preflight: NO network and NO DB",()=>{
  it("only returns sanitized readiness without executing collection",()=>{
    expect(validateMetaE07StagingPreflight(good,new Date("2026-10-12T00:00:00Z"))).toEqual({
      mode:"STAGING_META_COLLECTION_PREFLIGHT",readyForManualReview:true,provider:"meta",
      reportStart:"2026-10-01",reportEnd:"2026-10-02",
      databaseWritePerformed:false,providerCalled:false,campaignModified:false,spendAuthorized:false
    });
  });
  for(const [field,value] of [
    ["RENDER_SERVICE_NAME","noctella-production-api"],["RENDER_SERVICE_NAME",""],
    ["DATABASE_DRIVER","postgres"],["DATABASE_URL","/tmp/other.sqlite"],
    ["DATABASE_BACKUP_S3_BUCKET","noctella-production-db-backups"],
    ["DATABASE_BACKUP_S3_PREFIX",""],["NOCTELLA_PAID_ADS_PROVIDER","google_ads"],
    ["NOCTELLA_PAID_ADS_PREVIEW_ACK",""],["NOCTELLA_PAID_ADS_STAGE_WRITE_ACK",""],
    ["NOCTELLA_META_AD_ACCOUNT_ID","bad"],["NOCTELLA_PAID_ADS_CAMPAIGN_ID","bad"],
    ["NOCTELLA_PAID_ADS_START_DATE","2026-10-35"],["NOCTELLA_PAID_ADS_END_DATE","2026-09-01"]
  ]) {
    it("fails closed on "+field+"="+(value||"missing"),()=>{
      expect(()=>validateMetaE07StagingPreflight({...good,[field]:value},new Date("2026-10-12T00:00:00Z"))).toThrow("denied");
    });
  }
  it("rejects future or running days and excessive ranges",()=>{
    for(const patch of [{NOCTELLA_PAID_ADS_END_DATE:"2026-10-12"},
      {NOCTELLA_PAID_ADS_START_DATE:"2026-08-01"}]){
      expect(()=>validateMetaE07StagingPreflight({...good,...patch},new Date("2026-10-12T00:00:00Z"))).toThrow("denied");
    }
  });
});
