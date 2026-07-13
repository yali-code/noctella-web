export enum StockMovementType {
  Purchase = "Purchase",
  Sale = "Sale",
  ManualIncrease = "ManualIncrease",
  ManualDecrease = "ManualDecrease",
  ReturnIn = "ReturnIn",
  ReturnOut = "ReturnOut",
  Correction = "Correction",
}

export const STOCK_MOVEMENT_TYPE_VALUES: StockMovementType[] = Object.values(StockMovementType);
