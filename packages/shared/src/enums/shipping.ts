export enum CarrierCode { A1Post = "a1post", UPS = "ups", DHL = "dhl", FedEx = "fedex", DPD = "dpd", GLS = "gls", PostNord = "postnord", LocalPickup = "local_pickup", Other = "other" }
export enum ShipmentStatus { Draft = "draft", Ready = "ready", LabelPending = "label_pending", LabelCreated = "label_created", InTransit = "in_transit", Delivered = "delivered", DeliveryFailed = "delivery_failed", Cancelled = "cancelled", Returned = "returned" }
export enum MarketplaceFulfillmentStatus { Pending = "pending", Submitted = "submitted", Accepted = "accepted", Failed = "failed", Cancelled = "cancelled" }
export enum ShippingError { Validation = "Validation", Authentication = "Authentication", Authorization = "Authorization", NotFound = "NotFound", RateLimit = "RateLimit", Timeout = "Timeout", Temporary = "Temporary", Permanent = "Permanent", Tracking = "Tracking", Fulfillment = "Fulfillment", Financial = "Financial", Conflict = "Conflict", Unknown = "Unknown" }
/** Sprint 134: checkout-time shipping-method pricing rule (distinct from Shipment.carrierCode/shippingCost, which remain fulfillment-time concepts). Launch-scoped to these three; no weight/subtotal-tier/carrier-calculated rule exists yet. */
export enum ShippingRuleType { Free = "Free", FlatRate = "FlatRate", FreeOverSubtotal = "FreeOverSubtotal" }
/** Sprint 134: activates the previously-inert products.shippingProfile placeholder as a controlled eligibility-classification vocabulary. Unset/null on a Product is treated as Standard. Purely a classification key - shipping methods reference these values for eligibility, never a price. */
export enum ProductShippingProfile { Standard = "standard", Free = "free", Paid = "paid", Oversize = "oversize" }
export const CARRIER_CODE_VALUES = Object.values(CarrierCode);
export const SHIPMENT_STATUS_VALUES = Object.values(ShipmentStatus);
export const MARKETPLACE_FULFILLMENT_STATUS_VALUES = Object.values(MarketplaceFulfillmentStatus);
export const SHIPPING_RULE_TYPE_VALUES = Object.values(ShippingRuleType);
export const PRODUCT_SHIPPING_PROFILE_VALUES = Object.values(ProductShippingProfile);
export interface ShippingMethod { id: string; label: string; isActive: boolean; sortOrder: number; ruleType: ShippingRuleType | string; flatAmountEurCents: number | null; freeThresholdEurCents: number | null; countryCodes: string[] | null; shippingProfiles: string[] | null; createdAt: string; updatedAt: string }
export interface ShippingOption { shippingMethodId: string; label: string; ruleType: ShippingRuleType | string; amountEurCents: number }
export type ShipmentItem = { id: string; shipmentId: string; orderItemId: string; quantity: number; createdAt: string };
export type ShipmentEvent = { id: string; shipmentId: string; eventType: string; previousStatus?: ShipmentStatus | string; newStatus?: ShipmentStatus | string; payloadSnapshot?: unknown; errorCode?: string; errorMessage?: string; createdAt: string };
export type ShipmentTracking = { id: string; shipmentId: string; source: string; externalStatus?: string; normalizedStatus?: ShipmentStatus | string; location?: string; description?: string; occurredAt?: string; payloadSnapshot?: unknown; createdAt: string };
export type Shipment = { id: string; orderId: string; marketplaceOrderId?: string; channel?: string; carrierCode: CarrierCode | string; customCarrierName?: string; trackingNumber?: string; trackingUrl?: string; status: ShipmentStatus | string; shippingCost: number; currency: "EUR"; shippedAt?: string; deliveredAt?: string; cancelledAt?: string; returnedAt?: string; externalFulfillmentId?: string; marketplaceFulfillmentStatus?: MarketplaceFulfillmentStatus | string; lastError?: string; createdAt: string; updatedAt: string; items: ShipmentItem[] };
export type ShipmentUpdateResult = { shipment: Shipment; marketplaceStatus?: MarketplaceFulfillmentStatus | string; retryable?: boolean; error?: string };
export type CompleteSaleResult = { orderId: string; status: string; completedAt?: string; alreadyCompleted: boolean; financials?: SaleFinancials; issues: string[] };
export type SaleFinancials = { orderId: string; grossRevenue: number; shippingCharged: number; shippingCost: number; marketplaceFee: number | null; promotedFee: number | null; paymentFee: number | null; taxVat: number; itemCost: number; netRevenue: number; profit: number; currency: "EUR"; completedAt: string };
