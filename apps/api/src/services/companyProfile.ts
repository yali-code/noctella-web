import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { companyProfile } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { assertValidNumberIfPresent, ErpInvoiceTaxTreatment, NumericValidationError } from "@noctella/shared";

const COMPANY_PROFILE_ID = "default";
const now = () => new Date().toISOString();
const TAX_TREATMENTS = new Set(Object.values(ErpInvoiceTaxTreatment) as string[]);

/** Returns null if the profile has never been configured — callers must handle this explicitly rather than assume a default identity. */
export async function getCompanyProfile(db: DbClient) {
  const [row] = await db.select().from(companyProfile).where(eq(companyProfile.id, COMPANY_PROFILE_ID)).limit(1);
  return row ?? null;
}

export async function getCompanyProfileOrThrow(db: DbClient) {
  const row = await getCompanyProfile(db);
  if (!row) throw new NotFoundError("Company profile has not been configured");
  return row;
}

function assertRequiredFields(input: any, existing: any) {
  const merged = { ...existing, ...input };
  for (const field of ["legalName", "registrationNumber", "addressLine1", "city", "postalCode", "country", "email", "phone"]) {
    if (!String(merged[field] ?? "").trim()) throw new BadRequestError(`Company profile field "${field}" is required`);
  }
  // Sprint 79 correction: assertValidNumberIfPresent rejects NaN/Infinity/non-numeric strings
  // outright instead of the previous `Number(x) < 0 || Number(x) > 100` style range checks, which
  // silently let NaN (and non-numeric strings coerced to NaN) through since NaN compares false
  // against every bound.
  try {
    assertValidNumberIfPresent(input.defaultVatRate, "Default VAT rate", { min: 0, max: 100 });
    assertValidNumberIfPresent(input.defaultPaymentTermsDays, "Default payment terms", { min: 0, integer: true });
  } catch (error) {
    if (error instanceof NumericValidationError) throw new BadRequestError(error.message);
    throw error;
  }
  if (input.defaultTaxTreatment != null && !TAX_TREATMENTS.has(input.defaultTaxTreatment)) throw new BadRequestError("Invalid default tax treatment");
}

/** Create-or-update upsert for the single active profile row (id "default"). */
export async function upsertCompanyProfile(db: DbClient, input: any) {
  const existing = await getCompanyProfile(db);
  if (existing && input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt) throw new ConflictError("Company profile has changed since expectedUpdatedAt");
  assertRequiredFields(input, existing ?? {});
  const t = now();
  const fields = ["legalName", "tradeName", "registrationNumber", "vatNumber", "addressLine1", "addressLine2", "city", "postalCode", "country", "email", "phone", "website", "bankName", "iban", "bic", "invoiceFooter", "defaultPaymentTermsDays", "defaultVatRate", "defaultTaxTreatment", "defaultPricesIncludeVat"];
  if (existing) {
    const patch: any = { updatedAt: t };
    for (const f of fields) if (input[f] !== undefined) patch[f] = input[f];
    await db.update(companyProfile).set(patch).where(eq(companyProfile.id, COMPANY_PROFILE_ID));
  } else {
    const row: any = { id: COMPANY_PROFILE_ID, tradeName: null, vatNumber: null, addressLine2: null, website: null, bankName: null, iban: null, bic: null, invoiceFooter: null, defaultPaymentTermsDays: 14, defaultVatRate: 20, defaultTaxTreatment: ErpInvoiceTaxTreatment.StandardVAT, defaultPricesIncludeVat: false, createdAt: t, updatedAt: t };
    for (const f of fields) if (input[f] !== undefined) row[f] = input[f];
    await db.insert(companyProfile).values(row);
  }
  return getCompanyProfile(db);
}
