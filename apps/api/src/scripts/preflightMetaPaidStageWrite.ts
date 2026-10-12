/**
 * ADS-009K: E07 Meta-only staging preflight.
 * Deliberately has NO database imports, network calls, environment writes,
 * backup materialization, provider requests, or collection execution.
 * A PASS is permission to review readiness, NOT authorization to collect.
 */
export type E07PreflightEnv=Record<string,string|undefined>;
export type E07PreflightResult={
  mode:"STAGING_META_COLLECTION_PREFLIGHT";
  readyForManualReview:true;
  provider:"meta";
  reportStart:string;
  reportEnd:string;
  databaseWritePerformed:false;
  providerCalled:false;
  campaignModified:false;
  spendAuthorized:false;
};
const numericId=(v:string|undefined)=>typeof v==="string" && /^[0-9]{5,25}$/.test(v);
const strictDate=(v:string|undefined):v is string=>{
  if(typeof v!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v))return false;
  const ms=Date.parse(v+"T00:00:00.000Z");
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===v;
};
/** Stage identity guard reused by the separate read-only R2 audit.
 * A backup integrity check requires no fake Meta campaign or write authorization.
 */
export function assertMetaE07StagingEnvironment(env:E07PreflightEnv):void {
  if(env.RENDER_SERVICE_NAME!=="noctella-staging-api" ||
     env.DATABASE_DRIVER!=="sqlite" ||
     env.DATABASE_URL!=="/var/data/noctella.sqlite"){
    throw new Error("E07 preflight denied: staging identity or SQLite target mismatch");
  }
  if(env.DATABASE_BACKUP_S3_BUCKET!=="noctella-staging-db-backups" ||
     env.DATABASE_BACKUP_S3_PREFIX!=="database-backups"){
    throw new Error("E07 preflight denied: staging backup configuration mismatch");
  }
}
export function validateMetaE07StagingPreflight(env:E07PreflightEnv,now=new Date()):E07PreflightResult {
  assertMetaE07StagingEnvironment(env);
  if(env.NOCTELLA_PAID_ADS_PROVIDER!=="meta" ||
     env.NOCTELLA_PAID_ADS_PREVIEW_ACK!=="I_AUTHORIZE_PAID_READ_ONLY" ||
     env.NOCTELLA_PAID_ADS_STAGE_WRITE_ACK!=="I_AUTHORIZE_STAGING_SNAPSHOT_WRITE"){
    throw new Error("E07 preflight denied: scope or explicit acknowledgements missing");
  }
  if(!numericId(env.NOCTELLA_META_AD_ACCOUNT_ID) || !numericId(env.NOCTELLA_PAID_ADS_CAMPAIGN_ID)){
    throw new Error("E07 preflight denied: account or campaign scope invalid");
  }
  const start=env.NOCTELLA_PAID_ADS_START_DATE,end=env.NOCTELLA_PAID_ADS_END_DATE;
  if(!strictDate(start)||!strictDate(end))throw new Error("E07 preflight denied: date scope invalid");
  const a=Date.parse(start+"T00:00:00.000Z"),b=Date.parse(end+"T00:00:00.000Z");
  if(b<a||b-a>30*86400000||b+86400000>now.getTime()){
    throw new Error("E07 preflight denied: reporting dates incomplete or exceed 31 days");
  }
  return {mode:"STAGING_META_COLLECTION_PREFLIGHT",readyForManualReview:true,
    provider:"meta",reportStart:start,reportEnd:end,databaseWritePerformed:false,
    providerCalled:false,campaignModified:false,spendAuthorized:false};
}
async function main(){
  try{console.log(JSON.stringify(validateMetaE07StagingPreflight(process.env),null,2));}
  catch{console.error("E07 preflight denied. Staging identity, scoped consent, dates or backup settings did not pass.");process.exitCode=1;}
}
if(require.main===module)void main();
