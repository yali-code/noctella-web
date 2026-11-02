import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSchema } from "../src/db/migrate";
import { invoiceIntakes } from "../src/db/schema.sqlite";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import {
  assertAllowedInvoiceFile,
  countPdfPages,
  INVOICE_FILE_FORMAT_MESSAGE,
  INVOICE_FILE_MAX_BYTES,
  INVOICE_FILE_SIZE_MESSAGE,
  INVOICE_PDF_ENCRYPTED_MESSAGE,
  INVOICE_PDF_PAGES_MESSAGE,
  INVOICE_PDF_UNVERIFIABLE_MESSAGE,
} from "../src/services/invoiceFileGuard";
import { InvoiceFileStorageNotConfiguredError, LocalInvoiceFileStorage } from "../src/services/invoiceFileStorage";
import {
  addInvoiceIntakeFile,
  cancelInvoiceCostSet,
  cancelInvoiceIntake,
  createInvoiceCostSet,
  getInvoiceCostSet,
  getInvoiceIntakeFile,
  listInvoiceCostSets,
} from "../src/services/invoiceIntakes";
import { createTestDb } from "./testDb";

const root = path.resolve(__dirname, "..");
const migrationsDir = path.join(root, "src/db/postgres-migrations");
const TABLES = ["invoice_cost_sets", "invoice_intakes", "invoice_cost_set_items"];

/** Minimal valid PDF with `pages` page objects (and one /Pages tree node, which must not count). */
function pdfWithPages(pages: number, extra = ""): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj`,
    ...Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj`),
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\ntrailer\n<< /Root 1 0 R ${extra}>>\n%%EOF\n`, "latin1");
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

const pdfFile = (buffer = pdfWithPages(1), originalname = "invoice.pdf") => ({ buffer, mimetype: "application/pdf", originalname });

describe("invoice intake foundation (PHASE-2A)", () => {
  describe("schema and migration", () => {
    it("creates the three tables and their unique indexes on SQLite via ensureSchema (idempotently)", () => {
      const sqlite = new Database(":memory:");
      ensureSchema(sqlite);
      ensureSchema(sqlite);
      const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map((r) => r.name);
      for (const table of TABLES) expect(names).toContain(table);
      expect(names).toContain("idx_invoice_intakes_set_sha256");
      expect(names).toContain("idx_invoice_cost_set_items_set_product");
      sqlite.close();
    });

    it("PostgreSQL 0046 creates the same tables with the same columns, additively", () => {
      const sql = readFileSync(path.join(migrationsDir, "0046_invoice_intake_foundation.sql"), "utf8");
      expect([...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1])).toEqual(TABLES);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_intakes_set_sha256 ON invoice_intakes\(cost_set_id, file_sha256\)/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_cost_set_items_set_product ON invoice_cost_set_items\(cost_set_id, product_id\)/);
      expect(sql).not.toMatch(/\b(DROP|ALTER|RENAME|DELETE|UPDATE)\b/i);

      const sqlite = new Database(":memory:");
      ensureSchema(sqlite);
      for (const table of TABLES) {
        const sqliteColumns = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
        const block = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
        const body = block.slice(block.indexOf("(") + 1, block.indexOf("\n);"));
        const pgColumns = body.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).sort();
        expect(pgColumns).toEqual(sqliteColumns);
      }
      sqlite.close();
    });

    it("keeps 0042 absent and no photo_derivative table anywhere", () => {
      const files = readdirSync(migrationsDir);
      expect(files.some((f) => f.startsWith("0042"))).toBe(false);
      expect(files.filter((f) => f.startsWith("0046"))).toEqual(["0046_invoice_intake_foundation.sql"]);
      const all = files.map((f) => readFileSync(path.join(migrationsDir, f), "utf8")).join("\n") + readFileSync(path.join(root, "src/db/schema.sql"), "utf8");
      expect(all).not.toMatch(/photo_derivative/);
    });
  });

  describe("upload guard", () => {
    it("accepts a minimal valid PDF, JPEG and PNG", () => {
      expect(assertAllowedInvoiceFile({ buffer: pdfWithPages(1), mimetype: "application/pdf" })).toEqual({ mime: "application/pdf", ext: "pdf" });
      expect(assertAllowedInvoiceFile({ buffer: pdfWithPages(5), mimetype: "application/pdf" }).ext).toBe("pdf");
      expect(assertAllowedInvoiceFile({ buffer: JPEG, mimetype: "image/jpeg" })).toEqual({ mime: "image/jpeg", ext: "jpg" });
      expect(assertAllowedInvoiceFile({ buffer: PNG, mimetype: "image/png" })).toEqual({ mime: "image/png", ext: "png" });
    });

    it("counts /Type /Page objects but never /Pages", () => {
      expect(countPdfPages(pdfWithPages(3))).toBe(3);
    });

    const rejects = (file: { buffer: Buffer; mimetype: string }, message: string) => {
      expect(() => assertAllowedInvoiceFile(file)).toThrow(BadRequestError);
      expect(() => assertAllowedInvoiceFile(file)).toThrow(message);
    };

    it("rejects a MIME mismatch", () => {
      rejects({ buffer: PNG, mimetype: "image/jpeg" }, INVOICE_FILE_FORMAT_MESSAGE);
      rejects({ buffer: pdfWithPages(1), mimetype: "image/png" }, INVOICE_FILE_FORMAT_MESSAGE);
    });

    it("rejects a file over 5 MB", () => {
      const big = Buffer.concat([pdfWithPages(1), Buffer.alloc(INVOICE_FILE_MAX_BYTES)]);
      rejects({ buffer: big, mimetype: "application/pdf" }, INVOICE_FILE_SIZE_MESSAGE);
    });

    it("rejects a PDF with more than 5 pages", () => {
      rejects({ buffer: pdfWithPages(6), mimetype: "application/pdf" }, INVOICE_PDF_PAGES_MESSAGE);
    });

    it("rejects an encrypted PDF", () => {
      rejects({ buffer: pdfWithPages(1, "/Encrypt 9 0 R "), mimetype: "application/pdf" }, INVOICE_PDF_ENCRYPTED_MESSAGE);
    });

    it("rejects a PDF whose page count cannot be determined safely", () => {
      rejects({ buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 3 >>\nendobj\n%%EOF", "latin1"), mimetype: "application/pdf" }, INVOICE_PDF_UNVERIFIABLE_MESSAGE);
      rejects({ buffer: Buffer.from("%PDF-1.4\n%%EOF", "latin1"), mimetype: "application/pdf" }, INVOICE_PDF_UNVERIFIABLE_MESSAGE);
    });

    it("rejects an unknown format and an empty file with a generic message", () => {
      rejects({ buffer: Buffer.from("GIF89a....."), mimetype: "image/gif" }, INVOICE_FILE_FORMAT_MESSAGE);
      rejects({ buffer: Buffer.alloc(0), mimetype: "application/pdf" }, INVOICE_FILE_FORMAT_MESSAGE);
    });
  });

  describe("use cases", () => {
    let db: ReturnType<typeof createTestDb>;
    let dir: string;
    let storage: LocalInvoiceFileStorage;

    beforeEach(() => {
      db = createTestDb();
      dir = mkdtempSync(path.join(os.tmpdir(), "invoice-intake-"));
      storage = new LocalInvoiceFileStorage(dir);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("creates, lists, gets and cancels a cost set", async () => {
      const set = await createInvoiceCostSet(db as any, { title: "  Växjö 227552 – lot 5332164 ", notes: "first" });
      expect(set).toMatchObject({ status: "open", title: "Växjö 227552 – lot 5332164", notes: "first", purchaseId: null });
      await createInvoiceCostSet(db as any, { title: "Second" });

      const list = await listInvoiceCostSets(db as any, { page: 1, pageSize: 20 });
      expect(list.total).toBe(2);
      expect(list.items).toHaveLength(2);

      expect(await getInvoiceCostSet(db as any, set.id)).toMatchObject({ id: set.id, intakes: [] });
      expect((await cancelInvoiceCostSet(db as any, set.id)).status).toBe("cancelled");
      expect((await cancelInvoiceCostSet(db as any, set.id)).status).toBe("cancelled");
      expect((await listInvoiceCostSets(db as any, { page: 1, pageSize: 20, status: "open" })).total).toBe(1);
      await expect(getInvoiceCostSet(db as any, "missing")).rejects.toBeInstanceOf(NotFoundError);
      await expect(createInvoiceCostSet(db as any, { title: "   " })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("adds a file to an open set: stored at <set>/<intake>.<ext>, row uploaded, no path in output", async () => {
      const set = await createInvoiceCostSet(db as any, { title: "Lot" });
      const intake: any = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "auction", file: pdfFile(undefined, "C:\\fake\\..\\Faktura 12.pdf") }, storage);
      expect(intake).toMatchObject({ costSetId: set.id, invoiceType: "auction", status: "uploaded", fileMime: "application/pdf", originalFilenameSanitized: "Faktura 12.pdf" });
      expect(intake.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(intake).not.toHaveProperty("fileRelativePath");
      expect(JSON.stringify(intake)).not.toContain(dir);

      const onDisk = path.join(dir, set.id, `${intake.id}.pdf`);
      expect(readFileSync(onDisk)).toEqual(pdfWithPages(1));
      expect(readdirSync(path.join(dir, set.id))).toEqual([`${intake.id}.pdf`]);
      const [row] = await db.select().from(invoiceIntakes);
      expect(row.fileRelativePath).toBe(`${set.id}/${intake.id}.pdf`);

      const detail = await getInvoiceCostSet(db as any, set.id);
      expect(detail.intakes).toHaveLength(1);
      expect(await getInvoiceIntakeFile(db as any, intake.id, storage)).toMatchObject({ mime: "application/pdf", ext: "pdf", absolutePath: onDisk });
    });

    it("refuses a file for a set that is not open, and rejects an invalid invoice type", async () => {
      const set = await createInvoiceCostSet(db as any, { title: "Lot" });
      await expect(addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "bogus", file: pdfFile() }, storage)).rejects.toBeInstanceOf(BadRequestError);
      await cancelInvoiceCostSet(db as any, set.id);
      await expect(addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "auction", file: pdfFile() }, storage)).rejects.toBeInstanceOf(ConflictError);
      await expect(addInvoiceIntakeFile(db as any, { costSetId: "missing", invoiceType: "auction", file: pdfFile() }, storage)).rejects.toBeInstanceOf(NotFoundError);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("rejects the same file twice in one set, but allows it in another set", async () => {
      const a = await createInvoiceCostSet(db as any, { title: "A" });
      const b = await createInvoiceCostSet(db as any, { title: "B" });
      await addInvoiceIntakeFile(db as any, { costSetId: a.id, invoiceType: "auction", file: pdfFile() }, storage);
      await expect(addInvoiceIntakeFile(db as any, { costSetId: a.id, invoiceType: "transport", file: pdfFile() }, storage)).rejects.toBeInstanceOf(ConflictError);
      await addInvoiceIntakeFile(db as any, { costSetId: b.id, invoiceType: "auction", file: pdfFile() }, storage);
      expect(await db.select().from(invoiceIntakes)).toHaveLength(2);
      expect(readdirSync(path.join(dir, a.id))).toHaveLength(1);
    });

    it("cancels an intake only while the set is open and keeps the file", async () => {
      const set = await createInvoiceCostSet(db as any, { title: "Lot" });
      const intake: any = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "transport", file: { buffer: PNG, mimetype: "image/png", originalname: "t.png" } }, storage);
      expect((await cancelInvoiceIntake(db as any, intake.id)).status).toBe("cancelled");
      expect((await cancelInvoiceIntake(db as any, intake.id)).status).toBe("cancelled");
      expect(existsSync(path.join(dir, set.id, `${intake.id}.png`))).toBe(true);

      const other: any = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "auction", file: { buffer: JPEG, mimetype: "image/jpeg" } }, storage);
      await cancelInvoiceCostSet(db as any, set.id);
      await expect(cancelInvoiceIntake(db as any, other.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(cancelInvoiceIntake(db as any, "missing")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("fails closed when INVOICE_FILE_DIR is unset: no file, no row", async () => {
      const previous = process.env.INVOICE_FILE_DIR;
      delete process.env.INVOICE_FILE_DIR;
      try {
        const set = await createInvoiceCostSet(db as any, { title: "Lot" });
        const error = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "auction", file: pdfFile() }).catch((e) => e);
        expect(error).toBeInstanceOf(InvoiceFileStorageNotConfiguredError);
        expect(String(error.message)).not.toMatch(/[\\/]/);
        expect(await db.select().from(invoiceIntakes)).toHaveLength(0);
      } finally {
        if (previous === undefined) delete process.env.INVOICE_FILE_DIR; else process.env.INVOICE_FILE_DIR = previous;
      }
    });
  });
});
