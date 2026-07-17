import { describe, expect, it } from "vitest";
import { capabilities, createRefundProviderRegistry } from "../src/providers/refund";
import { FakeMarketplaceRefundProvider, FakePaymentRefundProvider, createFakeRefundProviderRegistry } from "../src/providers/refund/testing/fakes";

describe("refund provider registry Sprint 30B-R5", () => {
  it("resolves marketplace provider",()=>expect(createFakeRefundProviderRegistry({marketplace:{ebay:new FakeMarketplaceRefundProvider()}}).resolveMarketplaceProvider("ebay")).toBeTruthy());
  it("resolves payment provider",()=>expect(createFakeRefundProviderRegistry({payment:{stripe:new FakePaymentRefundProvider()}}).resolvePaymentProvider("stripe")).toBeTruthy());
  it("unknown marketplace fails deterministically",()=>expect(()=>createFakeRefundProviderRegistry().resolveMarketplaceProvider("missing")).toThrow(/Unsupported marketplace/));
  it("unknown payment fails deterministically",()=>expect(()=>createFakeRefundProviderRegistry().resolvePaymentProvider("missing")).toThrow(/Unsupported payment/));
  it("duplicate marketplace rejected",()=>expect(()=>createRefundProviderRegistry({marketplaceProviders:[{providerId:"ebay",provider:new FakeMarketplaceRefundProvider()},{providerId:"ebay",provider:new FakeMarketplaceRefundProvider()}]})).toThrow(/Duplicate marketplace/));
  it("duplicate payment rejected",()=>expect(()=>createRefundProviderRegistry({paymentProviders:[{providerId:"stripe",provider:new FakePaymentRefundProvider()},{providerId:"stripe",provider:new FakePaymentRefundProvider()}]})).toThrow(/Duplicate payment/));
  it("marketplace capabilities returned",()=>expect(createRefundProviderRegistry({marketplaceProviders:[{providerId:"etsy",provider:new FakeMarketplaceRefundProvider(),capabilities:capabilities({supportsRefundStatus:true})}]}).getMarketplaceCapabilities!("etsy").supportsRefundStatus).toBe(true));
  it("payment capabilities returned",()=>expect(createRefundProviderRegistry({paymentProviders:[{providerId:"paypal",provider:new FakePaymentRefundProvider(),capabilities:capabilities({supportsCancelRefund:true})}]}).getPaymentCapabilities!("paypal").supportsCancelRefund).toBe(true));
  it("has marketplace provider",()=>expect(createFakeRefundProviderRegistry({marketplace:{manual:new FakeMarketplaceRefundProvider()}}).hasMarketplaceProvider!("manual")).toBe(true));
  it("has payment provider false",()=>expect(createFakeRefundProviderRegistry().hasPaymentProvider!("stripe")).toBe(false));
  it("registry object immutable",()=>expect(Object.isFrozen(createFakeRefundProviderRegistry())).toBe(true));
  it("registry isolation",()=>{const a=createFakeRefundProviderRegistry({marketplace:{ebay:new FakeMarketplaceRefundProvider()}});const b=createFakeRefundProviderRegistry();expect(a.hasMarketplaceProvider!("ebay")).toBe(true);expect(b.hasMarketplaceProvider!("ebay")).toBe(false);});
  it("multiple provider ids deterministic",()=>{const r=createFakeRefundProviderRegistry({marketplace:{ebay:new FakeMarketplaceRefundProvider(),etsy:new FakeMarketplaceRefundProvider()}});expect(r.resolveMarketplaceProvider("etsy")).toBeTruthy();});
  it("empty id is unsupported",()=>expect(()=>createFakeRefundProviderRegistry().resolvePaymentProvider("")).toThrow(/Unsupported/));
  it("provider capabilities default execute",()=>expect(createFakeRefundProviderRegistry({payment:{internal:new FakePaymentRefundProvider()}}).getPaymentCapabilities!("internal").supportsExecuteRefund).toBe(true));
  it("capability overrides are frozen",()=>expect(Object.isFrozen(createFakeRefundProviderRegistry({payment:{stripe:new FakePaymentRefundProvider()}}).getPaymentCapabilities!("stripe"))).toBe(true));
  it("marketplace and payment namespaces independent",()=>{const r=createFakeRefundProviderRegistry({marketplace:{manual:new FakeMarketplaceRefundProvider()},payment:{manual:new FakePaymentRefundProvider()}});expect(r.resolveMarketplaceProvider("manual")).not.toBe(r.resolvePaymentProvider("manual"));});
  it("duplicate does not register partial registry",()=>expect(()=>createRefundProviderRegistry({paymentProviders:[{providerId:"x",provider:new FakePaymentRefundProvider()},{providerId:"x",provider:new FakePaymentRefundProvider()}]})).toThrow(/Duplicate/));
});
