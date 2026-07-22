export type SalesCompletionDependency = Readonly<{
  sideEffect: string; currentOwner: string; currentFunction: string; sourceData: string;
  mutation: string; transactionExpectation: string; idempotencyExpectation: string;
  existingAbstraction: string | null; newCoordinationCapability: string | null;
}>;

const row = (value: SalesCompletionDependency): SalesCompletionDependency => Object.freeze(value);
export const salesCompletionDependencyMatrix: readonly SalesCompletionDependency[] = Object.freeze([
  row({sideEffect:"sale status finalization",currentOwner:"Sales",currentFunction:"completeSale",sourceData:"sale id, expected version, completion timestamp",mutation:"sale status and updated timestamp",transactionExpectation:"coordinated completion unit",idempotencyExpectation:"completed sale remains completed",existingAbstraction:"SaleRepository",newCoordinationCapability:null}),
  row({sideEffect:"inventory quantity/status change",currentOwner:"Inventory sale creation",currentFunction:"decreaseInventoryForSaleInTransactionUseCase",sourceData:"sale line product and quantity",mutation:"inventory is reduced before completion",transactionExpectation:"sale creation transaction",idempotencyExpectation:"sale movement key",existingAbstraction:"Inventory application boundary",newCoordinationCapability:null}),
  row({sideEffect:"stock movement/history",currentOwner:"Inventory sale creation",currentFunction:"decreaseInventoryForSaleInTransactionUseCase",sourceData:"sale and line references",mutation:"sale stock movement appended before completion",transactionExpectation:"sale creation transaction",idempotencyExpectation:"movement idempotency key",existingAbstraction:"Inventory application boundary",newCoordinationCapability:null}),
  row({sideEffect:"product purchase-cost lookup",currentOwner:"Products",currentFunction:"getSaleCompletionReadiness/completeSale",sourceData:"product ids and quantities",mutation:"none",transactionExpectation:"consistent completion read",idempotencyExpectation:"same costs for same snapshot",existingAbstraction:null,newCoordinationCapability:"getProductCosts"}),
  row({sideEffect:"item cost snapshot and profit inputs",currentOwner:"Shipping compatibility",currentFunction:"completeSale",sourceData:"sale totals, costs, shipping cost",mutation:"financial snapshot values",transactionExpectation:"same completion coordination",idempotencyExpectation:"one snapshot per sale",existingAbstraction:null,newCoordinationCapability:"writeFinancialSnapshot"}),
  row({sideEffect:"sale financial snapshot persistence",currentOwner:"Finance bridge",currentFunction:"completeSale",sourceData:"EUR financial snapshot",mutation:"sale financial record inserted",transactionExpectation:"same completion coordination",idempotencyExpectation:"unique sale snapshot",existingAbstraction:null,newCoordinationCapability:"findFinancialSnapshot/writeFinancialSnapshot"}),
  row({sideEffect:"finance-entry creation",currentOwner:"Finance bridge",currentFunction:"createFinanceEntry",sourceData:"sale id, gross amount, EUR, snapshot",mutation:"CompleteSale finance entry inserted",transactionExpectation:"same completion coordination",idempotencyExpectation:"complete-sale:sale-id",existingAbstraction:null,newCoordinationCapability:"writeFinanceEntry"}),
  row({sideEffect:"shipment completion history",currentOwner:"Shipping",currentFunction:"event",sourceData:"shipment id, completion snapshot and timestamp",mutation:"shipment event appended",transactionExpectation:"after financial persistence",idempotencyExpectation:"completion replay must not append",existingAbstraction:null,newCoordinationCapability:"recordCompletionHistory"}),
  row({sideEffect:"marketplace fulfillment acceptance",currentOwner:"Shipping",currentFunction:"getSaleCompletionReadiness",sourceData:"optional channel and fulfillment status",mutation:"none during completion",transactionExpectation:"readiness read",idempotencyExpectation:"accepted state is stable",existingAbstraction:null,newCoordinationCapability:"inspectFulfillment"}),
  row({sideEffect:"payment and shipping compatibility",currentOwner:"Sales/Shipping",currentFunction:"getSaleCompletionReadiness",sourceData:"payment status and optional shipment",mutation:"none",transactionExpectation:"readiness read",idempotencyExpectation:"deterministic readiness",existingAbstraction:null,newCoordinationCapability:"inspectFulfillment"}),
  row({sideEffect:"completion replay/idempotency",currentOwner:"Sales financial snapshot",currentFunction:"completeSale",sourceData:"sale id",mutation:"none on replay",transactionExpectation:"snapshot check precedes writes",idempotencyExpectation:"existing snapshot returns replay",existingAbstraction:"SaleRepository plus snapshot uniqueness",newCoordinationCapability:"findFinancialSnapshot"}),
]);

export const rejectedSalesCompletionCandidatePorts = Object.freeze({
  SalesInventoryCoordinator: "completion performs no inventory mutation",
  SalesStockMovementRecorder: "completion performs no stock movement; sale creation already owns it",
  SalesMarketplaceFulfillmentCoordinator: "completion only reads acceptance through cohesive fulfillment inspection",
  SalesCompletionIdempotencyStore: "existing sale/snapshot uniqueness supplies replay detection",
});

