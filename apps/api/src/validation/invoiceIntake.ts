import { z } from "zod";
import { INVOICE_COST_SET_STATUSES, INVOICE_TYPES } from "../use-cases/invoice-intake/useCases";

/** PHASE-2A: request-shape validation only; business rules (open-set, duplicates, file guard) are in the use cases. */
export const createInvoiceCostSetSchema = z.object({
  title: z.string(),
  notes: z.string().nullable().optional(),
}).strict();

export const invoiceCostSetListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(INVOICE_COST_SET_STATUSES).optional(),
});

export const invoiceIntakeUploadFieldsSchema = z.object({
  invoiceType: z.enum(INVOICE_TYPES),
});
