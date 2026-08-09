import type { DbClient } from "../db/client";
import { createTransactionPaymentRepositories } from "../repositories/payment/drizzle";
import { getPaymentOperationsDetailUseCase } from "../use-cases/payment/useCases";

export function getPaymentOperationsDetail(db: DbClient, paymentId: string) {
  const driver = process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? "postgres" : "sqlite";
  return getPaymentOperationsDetailUseCase(createTransactionPaymentRepositories(db, driver)).execute(paymentId);
}
