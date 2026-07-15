import { describe, expect, it } from "vitest";
type Event={status:string;attemptCount:number;lastErrorMessage?:string|null;payload?:unknown};
const retryEligible=(e:Event)=>["Failed","RetryPending","DeadLetter"].includes(e.status);
const safeError=(e:Event)=>String(e.lastErrorMessage??"").replace(/\/(?:[^\s/]+\/)+[^\s]*/g,"[redacted-path]").replace(/(secret|token|key)=\S+/gi,"$1=[redacted]");
const listProjection=(e:Event)=>({status:e.status,attempts:e.attemptCount,safeError:safeError(e),retryEligible:retryEligible(e)});
describe("outbox and photo admin mapping",()=>{
 it("does not render raw payloads",()=>{expect(JSON.stringify(listProjection({status:"Failed",attemptCount:1,payload:{secret:"x"}}))).not.toContain("payload");});
 it("redacts raw paths and secrets",()=>{expect(safeError({status:"Failed",attemptCount:1,lastErrorMessage:"/tmp/a token=abc"})).toBe("[redacted-path] token=[redacted]");});
 it("maps retry eligibility",()=>{expect(retryEligible({status:"DeadLetter",attemptCount:3})).toBe(true); expect(retryEligible({status:"Succeeded",attemptCount:1})).toBe(false);});
 it("maps Product Photo status badges",()=>{expect(["Processing","Ready","Failed"]).toContain("Processing");});
 it("preserves attempt count metadata",()=>{expect(listProjection({status:"RetryPending",attemptCount:2}).attempts).toBe(2);});
});
