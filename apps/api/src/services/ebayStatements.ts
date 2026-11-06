import type { DbClient } from "../db/client";
import { createEbayStatementRepository } from "../repositories/ebay-statement/factory";
import { importEbayTransactionReportUseCase, listEbayStatementMonthsUseCase } from "../use-cases/ebay-statement/importTransactionReport";
import { previewEbayTransactionReportUseCase, type EbayStatementPreview } from "../use-cases/ebay-statement/previewTransactionReport";
import { BadRequestError } from "./errors";

export const EBAY_STATEMENT_MAX_BYTES = 5 * 1024 * 1024;

function reportText(file: Buffer | undefined): string {
  if (!file?.length) throw new BadRequestError("An eBay Transaction report CSV file is required");
  return file.toString("utf8");
}

export function previewEbayStatement(file: Buffer | undefined): EbayStatementPreview {
  return previewEbayTransactionReportUseCase(reportText(file));
}

export function importEbayStatement(db: DbClient, file: Buffer | undefined) {
  return importEbayTransactionReportUseCase(createEbayStatementRepository(undefined, db), reportText(file));
}

export function listEbayStatementMonths(db: DbClient) {
  return listEbayStatementMonthsUseCase(createEbayStatementRepository(undefined, db));
}
