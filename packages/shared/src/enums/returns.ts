export enum ReturnStatus { Requested="requested", Authorized="authorized", Rejected="rejected", AwaitingShipment="awaiting_shipment", InTransit="in_transit", Received="received", Inspecting="inspecting", Approved="approved", PartiallyApproved="partially_approved", Completed="completed", Cancelled="cancelled", Closed="closed" }
export enum ReturnReason { ChangedMind="changed_mind", NotAsDescribed="not_as_described", Damaged="damaged", Defective="defective", WrongItem="wrong_item", MissingParts="missing_parts", DeliveryIssue="delivery_issue", Other="other" }
export enum ReturnResolution { Refund="refund", PartialRefund="partial_refund", Replacement="replacement", Repair="repair", StoreCredit="store_credit", Reject="reject" }
export enum ReturnItemCondition { Unopened="unopened", OriginalCondition="original_condition", Used="used", Damaged="damaged", Incomplete="incomplete", Unsellable="unsellable" }
export enum ReturnStockDisposition { ReturnToStock="return_to_stock", Quarantine="quarantine", Damaged="damaged", Parts="parts", Discard="discard", NoStockChange="no_stock_change" }
export enum RefundStatus { Draft="draft", Pending="pending", Submitted="submitted", Succeeded="succeeded", Failed="failed", Cancelled="cancelled" }
export enum RefundType { Full="full", Partial="partial", ShippingOnly="shipping_only", Adjustment="adjustment" }
export enum MarketplaceReturnStatus { Open="open", Authorized="authorized", InTransit="in_transit", Received="received", Closed="closed", Failed="failed" }
export enum ReturnError { Validation="Validation", Authentication="Authentication", Authorization="Authorization", NotFound="NotFound", RateLimit="RateLimit", Timeout="Timeout", Temporary="Temporary", Permanent="Permanent", Stock="Stock", Financial="Financial", RefundLimit="RefundLimit", Conflict="Conflict", Unknown="Unknown" }
export const RETURN_STATUS_VALUES = Object.values(ReturnStatus);
export const REFUND_STATUS_VALUES = Object.values(RefundStatus);
