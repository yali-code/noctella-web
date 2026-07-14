export enum WarehouseStatus { Active = "Active", Inactive = "Inactive" }
export enum WarehouseLocationType { Warehouse = "Warehouse", Zone = "Zone", Shelf = "Shelf", Bin = "Bin", Quarantine = "Quarantine", Returns = "Returns", Packing = "Packing", Dispatch = "Dispatch" }
export enum WarehouseLocationStatus { Active = "Active", Inactive = "Inactive" }
export enum StockReservationStatus { Active = "Active", Released = "Released", Consumed = "Consumed", Expired = "Expired", Cancelled = "Cancelled" }
export enum StockReservationReason { Order = "Order", Manual = "Manual", Hold = "Hold", Replacement = "Replacement" }
export enum PickingTaskStatus { Pending = "Pending", InProgress = "InProgress", Picked = "Picked", Short = "Short", Cancelled = "Cancelled" }
export enum PackingTaskStatus { Pending = "Pending", InProgress = "InProgress", Packed = "Packed", ReadyForShipment = "ReadyForShipment", Cancelled = "Cancelled" }

export type Warehouse = { id:string; erpReferenceId?:string|null; name:string; code:string; status:WarehouseStatus; countryCode?:string|null; city?:string|null; addressSummary?:string|null; createdAt:string; updatedAt:string };
export type WarehouseLocation = { id:string; warehouseId:string; parentLocationId?:string|null; erpReferenceId?:string|null; code:string; name:string; locationType:WarehouseLocationType; status:WarehouseLocationStatus; sortOrder:number; createdAt:string; updatedAt:string };
export type ProductLocationAssignment = { id:string; productId:string; warehouseLocationId:string; isPrimary:boolean; referenceNote?:string|null; createdAt:string; updatedAt:string };
export type StockReservation = { id:string; orderId?:string|null; productId:string; reservationReference:string; reason:StockReservationReason|string; quantity:number; status:StockReservationStatus; expiresAt?:string|null; releasedAt?:string|null; consumedAt?:string|null; createdAt:string; updatedAt:string };
export type ReservationLine = { productId:string; quantity:number; reservationId?:string };
export type PickingTask = { id:string; orderId:string; shipmentId?:string|null; status:PickingTaskStatus; assignedClientId?:string|null; startedAt?:string|null; completedAt?:string|null; cancelledAt?:string|null; safeNotes?:string|null; createdAt:string; updatedAt:string };
export type PickingTaskLine = { id:string; pickingTaskId:string; productId:string; orderItemId?:string|null; sourceLocationId?:string|null; requestedQuantity:number; pickedQuantity:number; shortQuantity:number; createdAt:string; updatedAt:string };
export type PackingTask = { id:string; orderId:string; shipmentId?:string|null; pickingTaskId?:string|null; status:PackingTaskStatus; packageCount:number; totalWeight?:number|null; dimensionsSnapshot?:string|null; packingMaterialsSnapshot?:string|null; startedAt?:string|null; completedAt?:string|null; createdAt:string; updatedAt:string };
export type PackingTaskLine = { id:string; packingTaskId:string; productId:string; orderItemId?:string|null; quantity:number; createdAt:string };
export type PackingMaterial = { code?:string; name:string; quantity:number };
export type WarehouseEvent = { id:string; eventType:string; safeMetadata?:string|null; createdAt:string };
export type WarehouseMovementProjection = WarehouseEvent & { productId?:string|null; orderId?:string|null; shipmentId?:string|null };
export type WarehouseAvailabilityProjection = { productId:string; physicalQuantity:number; reservedQuantity:number; availableQuantity:number; activeReservationCount:number };
export type WarehouseQueueProjection = { orderId:string; orderNumber:string; shipmentId?:string|null; customerMaskedSummary:string; pickingStatus?:string|null; packingStatus?:string|null; packageCount:number; totalWeight?:number|null; readinessIssues:string[]; readyAt?:string|null };
export type ErpWarehouseCreateCommand = { commandId:string; idempotencyKey:string; payload: Partial<Warehouse> };
export type ErpWarehouseLocationCreateCommand = { commandId:string; idempotencyKey:string; payload: Partial<WarehouseLocation> };
export type ErpProductLocationAssignCommand = { commandId:string; idempotencyKey:string; payload: { productId:string; warehouseLocationId:string; isPrimary?:boolean; referenceNote?:string } };
export type ErpReservationCreateCommand = { commandId:string; idempotencyKey:string; payload: { productId:string; quantity:number; reservationReference:string; reason:string; orderId?:string; expiresAt?:string } };
export type ErpReservationReleaseCommand = { commandId:string; idempotencyKey:string; payload?: { reason?:string } };
export type ErpPickingCommand = { commandId:string; idempotencyKey:string; payload?: Record<string, unknown> };
export type ErpPackingCommand = ErpPickingCommand;
export type ErpShipmentReadyCommand = ErpPickingCommand;
