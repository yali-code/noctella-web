import type { StockMovementListQuery } from "../../validation/stockMovement";
import { NotFoundError } from "../../services/errors";
import type { UnitOfWork } from "../../services/unitOfWork";
import type { StockMovementRepositoryBundle } from "../../repositories/stock/types";
export interface StockUseCaseContext { unitOfWork: UnitOfWork; repositories: StockMovementRepositoryBundle }
export async function getStockBalanceUseCase(ctx: StockUseCaseContext, productId: string) { const b=await ctx.repositories.stockMovements.read.getBalance(productId); if(!b) throw new NotFoundError("Product not found"); return b; }
export async function getStockHistoryUseCase(ctx: StockUseCaseContext, query: StockMovementListQuery) { return ctx.repositories.stockMovements.read.getHistory(query); }
