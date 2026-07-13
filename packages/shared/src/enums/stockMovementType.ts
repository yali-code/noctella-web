export enum StockMovementType {
  ManualAdjustment = "manual_adjustment",
  Sale = "sale",
  SaleRollback = "sale_rollback",
}

export const STOCK_MOVEMENT_TYPE_VALUES: StockMovementType[] = Object.values(StockMovementType);
