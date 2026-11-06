export interface EbayStatementRowRecord {
  id: string;
  rowType: string;
  transactionDate: string;
  orderNumber: string | null;
  transactionId: string | null;
  referenceId: string | null;
  itemId: string | null;
  title: string | null;
  customLabel: string | null;
  shipCountry: string | null;
  shipCity: string | null;
  itemSubtotalUsd: number;
  shippingUsd: number;
  ebayTaxUsd: number;
  feesUsd: number;
  grossUsd: number;
  netEur: number;
  exchangeRate: number | null;
  fundsStatus: string | null;
  payoutId: string | null;
  payoutDate: string | null;
  description: string | null;
}

export interface EbayStatementImportRecord {
  id: string;
  fileSha256: string;
  seller: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
}

export interface EbayStatementRepository {
  findRowsByIds(ids: string[]): Promise<EbayStatementRowRecord[]>;
  insertRow(row: EbayStatementRowRecord, now: string): Promise<void>;
  updateRow(row: EbayStatementRowRecord, now: string): Promise<void>;
  insertImport(record: EbayStatementImportRecord, now: string): Promise<void>;
  listRows(): Promise<EbayStatementRowRecord[]>;
}
