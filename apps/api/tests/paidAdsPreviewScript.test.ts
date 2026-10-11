// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {previewPaidCampaignFromEnv} from "../src/scripts/previewPaidCampaign";
const env={
 NOCTELLA_PAID_ADS_PROVIDER:"meta",
 NOCTELLA_META_AD_ACCOUNT_ID:"123456789",
 NOCTELLA_META_AD_ACCESS_TOKEN:"fake-secret-token-for-test",
 NOCTELLA_PAID_ADS_CAMPAIGN_ID:"987654321",
 NOCTELLA_PAID_ADS_START_DATE:"2026-10-01",
 NOCTELLA_PAID_ADS_END_DATE:"2026-10-02",
};
describe("ADS-006F manual preview entrypoint",()=>{
 it("denies network access unless caller explicitly authorizes paid read",async()=>{
  const f=vi.fn() as unknown as typeof fetch;
  await expect(previewPaidCampaignFromEnv(env,f)).rejects.toThrow("authorization");
  expect(f).not.toHaveBeenCalled();
 });
 it("reads one paid provider report without DB, tokens in output or ad writes",async()=>{
  const f=vi.fn(async(input:RequestInfo|URL)=>{
    const u=new URL(String(input));
    return new Response(JSON.stringify(u.pathname.endsWith("/insights")?
      {data:[{campaign_id:"987654321",spend:"1.25",impressions:"75",clicks:"2",
        date_start:"2026-10-01",date_stop:"2026-10-02"}]}:
      {currency:"EUR",account_id:"123456789"}),{status:200});
  }) as unknown as typeof fetch;
  const result=await previewPaidCampaignFromEnv({
    ...env,NOCTELLA_PAID_ADS_PREVIEW_ACK:"I_AUTHORIZE_PAID_READ_ONLY"},f);
  expect(result.spendEur).toBe(1.25);
  expect(result.storagePerformed).toBe(false);
  expect(result.campaignModified).toBe(false);
  expect(result.spendAuthorized).toBe(false);
  expect(JSON.stringify(result)).not.toContain("fake-secret-token-for-test");
  expect(f).toHaveBeenCalledTimes(2);
 });
});
