import type { ErpInvoiceTaxTreatment } from "./salesFinanceBridge";

/** Sprint 79: database-backed seller identity used as the invoice seller-snapshot source. Singleton row (id "default"). */
export interface CompanyProfile {
  id: string;
  legalName: string;
  tradeName: string | null;
  registrationNumber: string;
  vatNumber: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string;
  country: string;
  email: string;
  phone: string;
  website: string | null;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  invoiceFooter: string | null;
  defaultPaymentTermsDays: number;
  defaultVatRate: number;
  defaultTaxTreatment: ErpInvoiceTaxTreatment;
  defaultPricesIncludeVat: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CompanyProfileUpdateCommand = Partial<Omit<CompanyProfile, "id" | "createdAt" | "updatedAt">> & { expectedUpdatedAt?: string };
