// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
import {createTestDb} from "./testDb";
import {collectPaidCampaignEvidence,storeVerifiedPaidCampaignEvidence} from "../src/services/paidAdsCollection";
import {assertPaidCampaignQuery,providerNumber,type PaidCampaignObservation,type PaidCampaignQuery} from "../src/use-cases/ads/paidCampaignCollectorContract";
import {readPaidCampaignReport} from "../src/use-cases/ads/adsPaidCampaignRead";
const query:PaidCampaignQuery={provider:"meta",accountId:"123456789",campaignId:"12345678901",startDate:"2026-10-01",endDate:"2026-10-02"};
const value:PaidCampaignObservation={provider:"meta",accountId:query.accountId,campaignId:query.campaignId,
 sourceReference:"meta.ads.graph_v26_insights",currency:"EUR",
 window:{start:"2026-10-01T00:00:00.000Z",end:"2026-10-03T00:00:00.000Z"},
 spendEur:5.25,clicks:10,impressions:600,providerReportedConversions:null,
 providerReportedConversionValueEur:null,warnings:[]};
describe("ADS-006F separate paid provider collection",()=>{
 it("rejects unapproved reads before any provider network call",async()=>{
  const db=createTestDb();const client={provider:"meta" as const,fetchCampaign:vi.fn(async()=>value)};
  await expect(collectPaidCampaignEvidence(db,client,query,{accessToken:"sensitive-access-token"})).rejects.toThrow(/permission/);
  expect(client.fetchCampaign).not.toHaveBeenCalled();
 });
 it("preview requires no write, does not authorize ad spend",async()=>{
  const db=createTestDb();const client={provider:"meta" as const,fetchCampaign:vi.fn(async()=>value)};
  const out=await collectPaidCampaignEvidence(db,client,query,{accessToken:"sensitive-access-token"},{explicitReadApproval:true,explicitSnapshotWriteApproval:false});
  expect(out.status).toBe("PREVIEW_ONLY");
  expect(out.spendAuthorized).toBe(false);
  const read=await readPaidCampaignReport(db,"meta",query.campaignId);
  expect(read.status).toBe("NOT_COLLECTED");
  expect(JSON.stringify(out)).not.toContain("sensitive-access-token");
 });
 it("stores strictly EUR report into Analytics Agent tables idempotently",async()=>{
  const db=createTestDb();
  const a=storeVerifiedPaidCampaignEvidence(db,query,value,new Date("2026-10-09T14:00:00.000Z"));
  const b=storeVerifiedPaidCampaignEvidence(db,query,value,new Date("2026-10-09T14:01:00.000Z"));
  expect(a.run.status).toBe("completed");expect(b.replayed).toBe(true);
  const read=await readPaidCampaignReport(db,"meta",query.campaignId);
  expect(read.status).toBe("REPORT_AVAILABLE");expect(read.evidence?.spendEur).toBe(5.25);
  expect(read.evidence?.reportedRoas).toBeNull();
  expect(read.marketplaceAttributionVerified).toBe(false);
 });
 it("blocks mismatched provider or EUR and unsupported observations",()=>{
  const db=createTestDb();
  expect(()=>storeVerifiedPaidCampaignEvidence(db,query,{...value,accountId:"999999999"})).toThrow();
  expect(()=>storeVerifiedPaidCampaignEvidence(db,query,{...value,currency:"USD" as "EUR"})).toThrow();
  expect(()=>storeVerifiedPaidCampaignEvidence(db,query,{...value,spendEur:-1})).toThrow();
  expect(()=>storeVerifiedPaidCampaignEvidence(db,query,{...value,spendEur:null,impressions:null,clicks:null})).toThrow();
 });
 it("rejects invalid ids, stale windows and fractional counts",()=>{
  expect(()=>assertPaidCampaignQuery({...query,campaignId:"123;DROP TABLE"})).toThrow();
  expect(()=>assertPaidCampaignQuery({...query,endDate:"2026-10-35"})).toThrow();
  expect(()=>providerNumber("4.8","count")).toThrow();
 });
 it("explicitly authorized backend collection persists the mock paid provider report exactly once",async()=>{
  const db=createTestDb();
  const client={provider:"meta" as const,fetchCampaign:vi.fn(async()=>value)};
  const first=await collectPaidCampaignEvidence(db,client,query,{accessToken:"fake-provider-report-token"},{
    explicitReadApproval:true,explicitSnapshotWriteApproval:true,now:new Date("2026-10-09T12:00:00.000Z")
  });
  expect(first.status).toBe("STORED");
  expect(first.spendAuthorized).toBe(false);
  expect(first.run?.status).toBe("completed");
  const second=await collectPaidCampaignEvidence(db,client,query,{accessToken:"fake-provider-report-token"},{
    explicitReadApproval:true,explicitSnapshotWriteApproval:true,now:new Date("2026-10-09T12:02:00.000Z")
  });
  expect(second.replayed).toBe(true);
  const evidence=await readPaidCampaignReport(db,"meta",query.campaignId);
  expect(evidence.status).toBe("REPORT_AVAILABLE");
  expect(evidence.evidence?.clicks).toBe(10);
  expect(evidence.marketplaceAttributionVerified).toBe(false);
 });

});
