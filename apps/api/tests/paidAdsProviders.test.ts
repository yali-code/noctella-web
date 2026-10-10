// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {MetaPaidCampaignClient} from "../src/integrations/ads/metaPaidCampaignClient";
import {GooglePaidCampaignClient} from "../src/integrations/ads/googlePaidCampaignClient";
import {PinterestPaidCampaignClient} from "../src/integrations/ads/pinterestPaidCampaignClient";
import {PaidProviderReadError} from "../src/integrations/ads/paidTransport";
import type {PaidCampaignQuery} from "../src/use-cases/ads/paidCampaignCollectorContract";
const token="not-a-real-token-123456789",accountId="123456789",campaignId="987654321";
const base={accountId,campaignId,startDate:"2026-10-01",endDate:"2026-10-02"};
function mockFetch(resolver:(url:URL,options:RequestInit)=>unknown){
  const calls:{url:URL,options:RequestInit}[]=[];
  const fn=vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const url=new URL(String(input));
    const request=options??{};
    calls.push({url,options:request});
    const body=resolver(url,request);
    return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
  }) as unknown as typeof fetch;
  return {fn,calls};
}
function checkCalls(calls:{url:URL,options:RequestInit}[]){
  for(const x of calls){
    expect(x.url.protocol).toBe("https:");
    expect(x.url.href).not.toContain(token);
    expect(x.url.searchParams.has("access_token")).toBe(false);
    expect((x.options.headers as Record<string,string>).Authorization).toBe("Bearer "+token);
    expect(x.options.redirect).toBe("error");
  }
}
describe("ADS-006F Meta paid analytics transport",()=>{
 it("parses a EUR campaign insights report without calling any ad mutation endpoint",async()=>{
  const fake=mockFetch((url)=>{
    if(url.pathname.endsWith("/insights"))return {data:[{
      campaign_id:campaignId,spend:"5.50",impressions:"400",clicks:"8",
      date_start:base.startDate,date_stop:base.endDate}]};
    return {account_id:accountId,currency:"EUR",timezone_name:"Europe/Sofia"};
  });
  const query:PaidCampaignQuery={...base,provider:"meta"};
  const r=await new MetaPaidCampaignClient(fake.fn).fetchCampaign(query,{accessToken:token});
  expect(r).toMatchObject({provider:"meta",spendEur:5.5,impressions:400,clicks:8,providerReportedConversions:null});
  // Account-local days (Europe/Sofia, UTC+3 in October), not UTC days.
  expect(r).toMatchObject({reportingTimeZone:"Europe/Sofia",window:{start:"2026-09-30T21:00:00.000Z",end:"2026-10-02T21:00:00.000Z"}});
  expect(fake.calls[0]?.url.searchParams.get("fields")).toContain("timezone_name");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls.every(x=>x.options.method==="GET")).toBe(true);
  checkCalls(fake.calls);
 });
 it("rejects missing or mismatched Meta ad account identity",async()=>{
  for(const account of [{currency:"EUR"},{account_id:"999999999",currency:"EUR"}]){
    const f=mockFetch(()=>account);
    await expect(new MetaPaidCampaignClient(f.fn).fetchCampaign(
      {...base,provider:"meta"},{accessToken:token}))
      .rejects.toBeInstanceOf(PaidProviderReadError);
    expect(f.calls).toHaveLength(1);
  }
 });
 it("rejects non-EUR account before querying insights",async()=>{
  const f=mockFetch(()=>({account_id:accountId,currency:"USD"}));
  await expect(new MetaPaidCampaignClient(f.fn).fetchCampaign({...base,provider:"meta"},{accessToken:token})).rejects.toThrow("EUR");
  expect(f.calls).toHaveLength(1);
 });
 it("blocks campaign mismatch and untrusted pagination",async()=>{
  const f=mockFetch(url=>url.pathname.endsWith("/insights")?{data:[{campaign_id:"234567890",spend:"5",date_start:base.startDate,date_stop:base.endDate}]}:{currency:"EUR"});
  await expect(new MetaPaidCampaignClient(f.fn).fetchCampaign({...base,provider:"meta"},{accessToken:token})).rejects.toBeInstanceOf(PaidProviderReadError);
 });
});
describe("ADS-006F Google Ads read-only GAQL",()=>{
 it("reads EUR micros using SELECT query, no campaign changes",async()=>{
  const f=mockFetch((_url,request)=>{
    const payload=JSON.parse(String(request.body));
    expect(payload.query).toContain("SELECT customer.id");
    expect(payload.query).not.toContain("UPDATE");
    if(payload.query.includes("FROM customer")){
      expect(payload.query).not.toContain("metrics.");
      return [{results:[{customer:{id:accountId,currencyCode:"EUR",timeZone:"Europe/Berlin"}}]}];
    }
    expect(payload.query).toContain("campaign.id = "+campaignId);
    return [{results:[{
      customer:{id:accountId,currencyCode:"EUR"},campaign:{id:campaignId},
      metrics:{costMicros:"12300000",impressions:"100",clicks:"15"}
    }]}];
  });
  const q:PaidCampaignQuery={...base,provider:"google_ads"};
  const report=await new GooglePaidCampaignClient(f.fn).fetchCampaign(q,{accessToken:token,developerToken:"fake-developer-token"});
  expect(report.spendEur).toBe(12.3);
  expect(report.clicks).toBe(15);
  // segments.date is customer-local (Europe/Berlin, UTC+2 in October).
  expect(report).toMatchObject({reportingTimeZone:"Europe/Berlin",window:{start:"2026-09-30T22:00:00.000Z",end:"2026-10-02T22:00:00.000Z"}});
  expect(f.calls).toHaveLength(2);
  expect(f.calls.every(x=>x.options.method==="POST")).toBe(true);
  expect(f.calls.every(x=>/googleAds:searchStream$/.test(x.url.pathname))).toBe(true);
  checkCalls(f.calls);
 });
 it("verifies real EUR account before accepting an empty campaign report",async()=>{
  const f=mockFetch((_url,request)=>{
    const query=JSON.parse(String(request.body)).query as string;
    return query.includes("FROM customer")
      ?[{results:[{customer:{id:accountId,currencyCode:"EUR",timeZone:"Europe/Berlin"}}]}]
      :[];
  });
  const result=await new GooglePaidCampaignClient(f.fn).fetchCampaign(
    {...base,provider:"google_ads"}, {accessToken:token,developerToken:"fake-developer-token"});
  expect(result).toMatchObject({
    currency:"EUR",spendEur:null,clicks:null,impressions:null,
    warnings:["NO_CAMPAIGN_REPORT"],
  });
  expect(f.calls).toHaveLength(2);
  checkCalls(f.calls);
 });
 it("blocks a non-EUR, mismatched or time-zone-less customer before requesting campaign data",async()=>{
  for(const customer of [
    {id:accountId,currencyCode:"GBP",timeZone:"Europe/Berlin"},
    {id:"999999999",currencyCode:"EUR",timeZone:"Europe/Berlin"},
    {id:accountId,currencyCode:"EUR"},
    {id:accountId,currencyCode:"EUR",timeZone:"Not/A_Zone"},
  ]){
    const f=mockFetch(()=>[{results:[{customer}]}]);
    await expect(new GooglePaidCampaignClient(f.fn).fetchCampaign(
      {...base,provider:"google_ads"},
      {accessToken:token,developerToken:"fake-developer-token"})).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }
 });
 it("fails closed on malformed or missing customer stream evidence",async()=>{
  for(const invalid of [[], [{}], [{results:[{}]}], [{results:"not-an-array"}]]){
    const f=mockFetch(()=>invalid);
    await expect(new GooglePaidCampaignClient(f.fn).fetchCampaign(
      {...base,provider:"google_ads"},
      {accessToken:token,developerToken:"fake-developer-token"})).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }
 });
 it("refuses Google Ads access without separately granted developer token",async()=>{
  const f=mockFetch(()=>[]);
  await expect(new GooglePaidCampaignClient(f.fn).fetchCampaign({...base,provider:"google_ads"},{accessToken:token})).rejects.toThrow("developer token");
  expect(f.calls).toHaveLength(0);
 });
});
describe("ADS-006F Pinterest paid campaign analytics",()=>{
 it("uses paid campaigns endpoint, not organic Pinterest Pin API",async()=>{
  const f=mockFetch(url=>url.pathname.endsWith("/analytics")
    ?[{CAMPAIGN_ID:campaignId,SPEND_IN_MICRO_DOLLAR:3990000,TOTAL_IMPRESSION:700,TOTAL_CLICKTHROUGH:11}]
    :{id:accountId,currency:"EUR"});
  const report=await new PinterestPaidCampaignClient(f.fn).fetchCampaign({...base,provider:"pinterest_ads"},{accessToken:token});
  expect(report).toMatchObject({spendEur:3.99,impressions:700,clicks:11,providerReportedConversionValueEur:null});
  expect(report).toMatchObject({reportingTimeZone:"UTC",window:{start:"2026-10-01T00:00:00.000Z",end:"2026-10-03T00:00:00.000Z"}});
  expect(f.calls).toHaveLength(2);
  expect(f.calls.every(x=>x.options.method==="GET")).toBe(true);
  expect(f.calls[1]?.url.pathname).toContain("/campaigns/analytics");
  expect(f.calls[1]?.url.searchParams.get("columns")).toContain("SPEND_IN_MICRO_DOLLAR");
  checkCalls(f.calls);
 });
 it("uses verified EUR micro-units and explicitly warns when rounding cents",async()=>{
  const f=mockFetch(url=>url.pathname.endsWith("/analytics")
    ?[{CAMPAIGN_ID:campaignId,SPEND_IN_MICRO_DOLLAR:1234567,
       TOTAL_IMPRESSION:500,TOTAL_CLICKTHROUGH:4}]
    :{id:accountId,currency:"EUR"});
  const report=await new PinterestPaidCampaignClient(f.fn).fetchCampaign(
    {...base,provider:"pinterest_ads"},{accessToken:token});
  expect(report.spendEur).toBe(1.23);
  expect(report.warnings).toContain("EUR_MICRO_COST_ROUNDED_TO_CENTS");
 });
 it("denies missing or mismatched Pinterest account identity before campaign report",async()=>{
  for(const account of [{currency:"EUR"},{id:"999999999",currency:"EUR"}]){
    const f=mockFetch(()=>account);
    await expect(new PinterestPaidCampaignClient(f.fn).fetchCampaign(
      {...base,provider:"pinterest_ads"},{accessToken:token}))
      .rejects.toBeInstanceOf(PaidProviderReadError);
    expect(f.calls).toHaveLength(1);
  }
 });
 it("rejects account currency mismatch",async()=>{
  const f=mockFetch(()=>({id:accountId,currency:"GBP"}));
  await expect(new PinterestPaidCampaignClient(f.fn).fetchCampaign({...base,provider:"pinterest_ads"},{accessToken:token})).rejects.toThrow("EUR");
  expect(f.calls).toHaveLength(1);
 });
});
