import { BadRequestError } from "./errors";
import { previewEbayTransactionReportUseCase, type EbayStatementPreview } from "../use-cases/ebay-statement/previewTransactionReport";

export const EBAY_STATEMENT_MAX_BYTES = 5 * 1024 * 1024;

export function previewEbayStatement(file: Buffer | undefined): EbayStatementPreview {
  if (!file?.length) throw new BadRequestError("An eBay Transaction report CSV file is required");
  return previewEbayTransactionReportUseCase(file.toString("utf8"));
}
