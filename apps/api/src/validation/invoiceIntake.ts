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

/** PHASE-2B: review body. Each edit key is optional (absent = keep the AI value) and nullable (null = clear it). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const text = (max: number) => z.string().trim().max(max);
const amount = z.number().finite();
const invoiceLotEditSchema = z.object({
  lotNumber: text(64).nullable(),
  title: text(500).nullable(),
  itemCountHint: z.number().int().min(0).nullable(),
  amount: amount.nullable(),
}).strict();
const invoiceFeeEditSchema = z.object({
  type: z.enum(["hammer_fee", "buyer_premium", "transport", "other"]).nullable(),
  label: text(500).nullable(),
  amount: amount.nullable(),
  percent: z.number().finite().min(0).max(100).nullable(),
  lotNumber: text(64).nullable(),
}).strict();

export const invoiceIntakeReviewSchema = z.object({
  edits: z.object({
    invoiceType: z.enum(INVOICE_TYPES).nullable(),
    supplierName: text(200).nullable(),
    supplierVatNumber: text(64).nullable(),
    platform: text(100).nullable(),
    invoiceNumber: text(100).nullable(),
    issueDate: isoDate.nullable(),
    dueDate: isoDate.nullable(),
    paidDate: isoDate.nullable(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/, "Use an ISO currency code").nullable(),
    vatNote: text(1000).nullable(),
    reverseCharge: z.boolean().nullable(),
    total: amount.nullable(),
    lots: z.array(invoiceLotEditSchema).max(200),
    fees: z.array(invoiceFeeEditSchema).max(200),
  }).partial().strict().default({}),
  confirm: z.boolean().default(false),
}).strict();
