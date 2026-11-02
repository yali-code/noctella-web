import { z } from "zod";

/**
 * PHASE-2B: the structured output the model must return for one invoice document. Every scalar is wrapped as
 * { value, evidence, confidence }: evidence is a short verbatim snippet from the document (or null), confidence
 * is 0..1. The JSON Schema (sent to OpenAI with strict: true) and the Zod schema (applied to the model output)
 * are built from the same field lists below so they cannot drift. Strict mode requires every property in
 * `required` and additionalProperties: false; "optional" values are nullable instead.
 */
export const EXTRACTION_INVOICE_TYPES = ["auction", "transport", "forwarder", "other"] as const;
export const EXTRACTION_FEE_TYPES = ["hammer_fee", "buyer_premium", "transport", "other"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

type Kind = "string" | "number" | "integer" | "boolean" | "date" | "currency" | { enum: readonly string[] };

const HEADER_FIELDS = {
  invoiceType: { enum: EXTRACTION_INVOICE_TYPES },
  supplierName: "string",
  supplierVatNumber: "string",
  platform: "string",
  invoiceNumber: "string",
  issueDate: "date",
  dueDate: "date",
  paidDate: "date",
  currency: "currency",
  vatNote: "string",
  reverseCharge: "boolean",
  total: "number",
} as const satisfies Record<string, Kind>;

const LOT_FIELDS = { lotNumber: "string", title: "string", itemCountHint: "integer", amount: "number" } as const satisfies Record<string, Kind>;
const FEE_FIELDS = { type: { enum: EXTRACTION_FEE_TYPES }, label: "string", amount: "number", percent: "number", lotNumber: "string" } as const satisfies Record<string, Kind>;

export const INVOICE_HEADER_FIELD_NAMES = Object.keys(HEADER_FIELDS) as Array<keyof typeof HEADER_FIELDS>;
export const INVOICE_LOT_FIELD_NAMES = Object.keys(LOT_FIELDS) as Array<keyof typeof LOT_FIELDS>;
export const INVOICE_FEE_FIELD_NAMES = Object.keys(FEE_FIELDS) as Array<keyof typeof FEE_FIELDS>;

function jsonValueSchema(kind: Kind): Record<string, unknown> {
  if (typeof kind === "object") return { type: ["string", "null"], enum: [...kind.enum, null] };
  if (kind === "date") return { type: ["string", "null"], description: "ISO date YYYY-MM-DD" };
  if (kind === "currency") return { type: ["string", "null"], description: "ISO 4217 currency code, e.g. SEK" };
  if (kind === "number") return { type: ["number", "null"], description: "Plain decimal number, no thousands separator" };
  return { type: [kind, "null"] };
}

function jsonFieldSchema(kind: Kind) {
  return {
    type: "object",
    properties: {
      value: jsonValueSchema(kind),
      evidence: { type: ["string", "null"], description: "Short verbatim snippet from the document supporting the value, or null" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["value", "evidence", "confidence"],
    additionalProperties: false,
  };
}

function jsonObjectSchema(fields: Record<string, Kind>, extra: Record<string, unknown> = {}) {
  const properties: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(fields)) properties[name] = jsonFieldSchema(kind);
  Object.assign(properties, extra);
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export function buildInvoiceExtractionJsonSchema() {
  return jsonObjectSchema(HEADER_FIELDS, {
    lots: { type: "array", items: jsonObjectSchema(LOT_FIELDS) },
    fees: { type: "array", items: jsonObjectSchema(FEE_FIELDS) },
  });
}

function zodValue(kind: Kind): z.ZodTypeAny {
  if (typeof kind === "object") return z.enum(kind.enum as [string, ...string[]]).nullable();
  switch (kind) {
    case "date": return z.string().regex(ISO_DATE).nullable();
    case "currency": return z.string().regex(ISO_CURRENCY).nullable();
    case "number": return z.number().finite().nullable();
    case "integer": return z.number().int().nullable();
    case "boolean": return z.boolean().nullable();
    default: return z.string().nullable();
  }
}

function zodField(kind: Kind) {
  return z.object({ value: zodValue(kind), evidence: z.string().nullable(), confidence: z.number().min(0).max(1) }).strict();
}

function zodObject<T extends Record<string, Kind>>(fields: T) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, kind] of Object.entries(fields)) shape[name] = zodField(kind);
  return z.object(shape).strict();
}

export const invoiceExtractionZodSchema = zodObject(HEADER_FIELDS).extend({
  lots: z.array(zodObject(LOT_FIELDS)),
  fees: z.array(zodObject(FEE_FIELDS)),
}).strict();

export interface ExtractedField<T> { value: T | null; evidence: string | null; confidence: number }
export interface InvoiceExtractionLot {
  lotNumber: ExtractedField<string>; title: ExtractedField<string>; itemCountHint: ExtractedField<number>; amount: ExtractedField<number>;
}
export interface InvoiceExtractionFee {
  type: ExtractedField<(typeof EXTRACTION_FEE_TYPES)[number]>; label: ExtractedField<string>; amount: ExtractedField<number>; percent: ExtractedField<number>; lotNumber: ExtractedField<string>;
}
export interface InvoiceExtraction {
  invoiceType: ExtractedField<(typeof EXTRACTION_INVOICE_TYPES)[number]>;
  supplierName: ExtractedField<string>;
  supplierVatNumber: ExtractedField<string>;
  platform: ExtractedField<string>;
  invoiceNumber: ExtractedField<string>;
  issueDate: ExtractedField<string>;
  dueDate: ExtractedField<string>;
  paidDate: ExtractedField<string>;
  currency: ExtractedField<string>;
  vatNote: ExtractedField<string>;
  reverseCharge: ExtractedField<boolean>;
  total: ExtractedField<number>;
  lots: InvoiceExtractionLot[];
  fees: InvoiceExtractionFee[];
}

/** Returns the validated extraction, or null for any malformed output (the caller maps null to one generic error). */
export function parseInvoiceExtraction(raw: unknown): InvoiceExtraction | null {
  const result = invoiceExtractionZodSchema.safeParse(raw);
  return result.success ? (result.data as unknown as InvoiceExtraction) : null;
}
