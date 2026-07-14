import type { ID } from "./index";

export enum ErpClientStatus { Disconnected="Disconnected", Connected="Connected", Degraded="Degraded", Unauthorized="Unauthorized", VersionMismatch="VersionMismatch", Error="Error" }
export enum ErpIntegrationCapability { ReadProducts="ReadProducts", ReadInventory="ReadInventory", ReadProductPhotos="ReadProductPhotos", IdentityCheck="IdentityCheck", FieldMapping="FieldMapping", SyncCheckpoint="SyncCheckpoint", ValidateCommands="ValidateCommands" }
export interface ErpIntegrationHealth { status: ErpClientStatus; apiVersion: string; minimumClientVersion: string; latestClientVersion: string; serverTime: string; database: "Healthy"|"Degraded"; readOnly: boolean; writesEnabled: boolean; degradedServices: string[]; }
export interface ErpProductReference { centralProductId: ID; erpReferenceId?: string; sku?: string; noctellaId?: string; }
export interface ErpProductProjection extends ErpProductReference { title: string; status: string; category?: string; collection?: string; brand?: string; condition?: string; dimensions?: { length?: number; width?: number; height?: number; unit?: string }; weight?: { value?: number; unit?: string }; purchaseCost?: number; priceEur: number; physicalStock: number; reservedStock: number; reservedStockSupported: boolean; availableStock: number; primaryPhoto?: string; workflowMetadata?: Record<string, unknown>; updatedAt: string; }
export interface ErpProductMapping { erpField: string; owner: ErpFieldOwnership; targetField?: string; writableInFuture: boolean; currentSprintMode: "ReadOnly"|"Unsupported"|"Deferred"; notes: string; dataLossRisk: "None"|"Low"|"Medium"|"High"; }
export enum ErpFieldOwnership { ERP="ERP", Web="Web", Shared="Shared", Derived="Derived" }
export interface ErpSyncCheckpoint { checkpointToken: string; generatedAt: string; latestProductUpdatedAt?: string; latestStockMovementCreatedAt?: string; latestOrderUpdatedAt?: string; latestShipmentUpdatedAt?: string; latestReturnRefundUpdatedAt?: string; apiVersion: string; schemaVersion: string; }
export interface ErpCommandEnvelope { commandId: string; requestId: string; clientId: string; clientVersion: string; commandType: string; entityType: string; entityId?: string; idempotencyKey: string; payload: unknown; createdAt: string; }
export interface ErpCommandResult { commandId?: string; requestId?: string; status: "Valid"|"Invalid"|"NotEnabled"; errors: string[]; readOnly: boolean; }
export interface ErpIntegrationError { code: string; message: string; }
export interface ErpApiVersionInfo { apiVersion: string; minimumSupportedErpClientVersion: string; latestSupportedErpClientVersion: string; serverTime: string; compatible: boolean; }
