/** Operator-declared physical state, chosen after testing the item - never inferred by AI. */
export enum ProductCondition {
  Used = "Used",
  ForParts = "For parts",
  Unused = "Unused",
  NewOldStock = "New old stock",
}

export const PRODUCT_CONDITION_VALUES: ProductCondition[] = Object.values(ProductCondition);
