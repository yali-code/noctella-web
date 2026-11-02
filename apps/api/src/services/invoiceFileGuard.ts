/**
 * PHASE-2A: content guard for uploaded invoice files, in the style of imageFormatGuard.ts.
 *
 * - Allowed formats: PDF (magic "%PDF-" at offset 0), JPEG, PNG. The declared MIME type must equal the detected one.
 * - At most INVOICE_FILE_MAX_BYTES bytes; a PDF has at most INVOICE_PDF_MAX_PAGES pages.
 * - Page count is a minimal, dependency-free check (no PDF parsing library): distinct indirect objects whose dictionary
 *   declares "/Type /Page" (never "/Pages"). When it cannot be determined safely the file is rejected: no page object
 *   found, or page objects possibly hidden in compressed object streams ("/ObjStm").
 * - Encrypted PDFs ("/Encrypt" anywhere) are rejected.
 *
 * Every rejection is a plain BadRequestError with a fixed, generic message (no paths or internals).
 */
import { BadRequestError } from "./errors";
import { detectImageSignature } from "./imageFormatGuard";

export const INVOICE_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const INVOICE_PDF_MAX_PAGES = 5;
export const INVOICE_FILE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type InvoiceFileMime = (typeof INVOICE_FILE_MIME_TYPES)[number];

export const INVOICE_FILE_FORMAT_MESSAGE = "Invoice files must be PDF, JPEG, or PNG";
export const INVOICE_FILE_SIZE_MESSAGE = "Invoice files must be 5 MB or smaller";
export const INVOICE_PDF_PAGES_MESSAGE = "Invoice PDFs must have at most 5 pages";
export const INVOICE_PDF_ENCRYPTED_MESSAGE = "Encrypted or password-protected PDFs are not accepted";
export const INVOICE_PDF_UNVERIFIABLE_MESSAGE = "The PDF page count could not be verified; re-save the invoice as a standard PDF";

const EXTENSION: Readonly<Record<InvoiceFileMime, string>> = Object.freeze({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" });
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** The allowed invoice format these bytes start with, or null. Pure. */
export function detectInvoiceFileSignature(head: Buffer): InvoiceFileMime | null {
  if (head.length >= PDF_MAGIC.length && head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return "application/pdf";
  const image = detectImageSignature(head);
  if (image === "jpeg") return "image/jpeg";
  if (image === "png") return "image/png";
  return null;
}

/** Page count of a PDF, or null when it cannot be determined safely. Pure; never decompresses anything. */
export function countPdfPages(buffer: Buffer): number | null {
  const text = buffer.toString("latin1");
  if (/\/Type\s*\/ObjStm\b/.test(text)) return null;
  const pages = new Set<string>();
  for (const match of text.matchAll(/(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    // "/Page" followed by a delimiter only, so "/Pages" (the page tree) never counts.
    if (/\/Type\s*\/Page(?![A-Za-z0-9_.#-])/.test(match[3])) pages.add(match[1]);
  }
  return pages.size > 0 ? pages.size : null;
}

/** Validates an uploaded invoice file; returns its canonical MIME type and on-disk extension. */
export function assertAllowedInvoiceFile(file: { buffer: Buffer; mimetype: string }): { mime: InvoiceFileMime; ext: string } {
  if (file.buffer.length === 0) throw new BadRequestError(INVOICE_FILE_FORMAT_MESSAGE);
  if (file.buffer.length > INVOICE_FILE_MAX_BYTES) throw new BadRequestError(INVOICE_FILE_SIZE_MESSAGE);
  const detected = detectInvoiceFileSignature(file.buffer);
  if (!detected || detected !== file.mimetype) throw new BadRequestError(INVOICE_FILE_FORMAT_MESSAGE);
  if (detected === "application/pdf") {
    if (/\/Encrypt\b/.test(file.buffer.toString("latin1"))) throw new BadRequestError(INVOICE_PDF_ENCRYPTED_MESSAGE);
    const pages = countPdfPages(file.buffer);
    if (pages === null) throw new BadRequestError(INVOICE_PDF_UNVERIFIABLE_MESSAGE);
    if (pages > INVOICE_PDF_MAX_PAGES) throw new BadRequestError(INVOICE_PDF_PAGES_MESSAGE);
  }
  return { mime: detected, ext: EXTENSION[detected] };
}
