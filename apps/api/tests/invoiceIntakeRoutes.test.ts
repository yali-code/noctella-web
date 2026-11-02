import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

/**
 * PHASE-2A: route-level (real HTTP) tests for the invoice cost set / intake endpoints. Same harness as
 * purchaseRoutesSprint57B.test.ts: the real routes/erp.ts router over an isolated in-memory SQLite db,
 * authenticated with a real X-Noctella-ERP-Key; INVOICE_FILE_DIR points at a temp dir.
 */
let harnessDb: any;
vi.mock("../src/db/client", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { ensureSchema } = await import("../src/db/migrate");
  const schema = await import("../src/db/schema");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  harnessDb = drizzle(sqlite, { schema });
  return { db: harnessDb, dbRuntime: { driver: "sqlite", db: harnessDb, shutdown: async () => sqlite.close() } };
});

const ERP_KEY = "test-erp-key-2a";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");

describe("invoice intake ERP routes (PHASE-2A)", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  const previousDir = process.env.INVOICE_FILE_DIR;
  const headers = { "X-Noctella-ERP-Key": ERP_KEY, "X-Noctella-ERP-Client-Version": "0.1.0" };

  beforeAll(async () => {
    process.env.ERP_INTEGRATION_KEY = ERP_KEY;
    dir = mkdtempSync(path.join(os.tmpdir(), "invoice-routes-"));
    process.env.INVOICE_FILE_DIR = dir;
    const erpRouter = (await import("../src/routes/erp")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/erp", erpRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.INVOICE_FILE_DIR; else process.env.INVOICE_FILE_DIR = previousDir;
  });

  const createSet = async (title = "Lot 1") => {
    const res = await fetch(`${baseUrl}/api/erp/invoice-cost-sets`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    expect(res.status).toBe(201);
    return res.json() as Promise<any>;
  };
  const upload = (setId: string, file: Blob, name: string, invoiceType = "auction") => {
    const form = new FormData();
    form.append("invoiceType", invoiceType);
    form.append("file", file, name);
    return fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/files`, { method: "POST", headers, body: form });
  };

  it("requires the ERP key on every endpoint", async () => {
    const calls: Array<[string, string]> = [
      ["POST", "/invoice-cost-sets"], ["GET", "/invoice-cost-sets"], ["GET", "/invoice-cost-sets/x"], ["POST", "/invoice-cost-sets/x/cancel"],
      ["POST", "/invoice-cost-sets/x/files"], ["POST", "/invoice-intakes/x/cancel"], ["GET", "/invoice-intakes/x/file"],
    ];
    for (const [method, url] of calls) {
      const res = await fetch(`${baseUrl}/api/erp${url}`, { method, headers: { "X-Noctella-ERP-Client-Version": "0.1.0" } });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("creates, lists, gets and cancels a cost set", async () => {
    const set = await createSet("Växjö 227552");
    const list = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets`, { headers })).json();
    expect(list.items.map((s: any) => s.id)).toContain(set.id);
    const detail = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${set.id}`, { headers })).json();
    expect(detail).toMatchObject({ id: set.id, status: "open", intakes: [] });
    const cancelled = await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${set.id}/cancel`, { method: "POST", headers });
    expect((await cancelled.json()).status).toBe("cancelled");
    expect((await upload(set.id, new Blob([PDF], { type: "application/pdf" }), "a.pdf")).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/erp/invoice-cost-sets/missing`, { headers })).status).toBe(404);
  });

  it("uploads multipart, streams the file with correct headers and never exposes an absolute path", async () => {
    const set = await createSet();
    const res = await upload(set.id, new Blob([PDF], { type: "application/pdf" }), "Faktura.pdf");
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(dir);
    expect(text).not.toContain("fileRelativePath");
    const intake = JSON.parse(text);
    expect(intake).toMatchObject({ status: "uploaded", invoiceType: "auction", originalFilenameSanitized: "Faktura.pdf" });

    const detail = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${set.id}`, { headers })).text();
    expect(detail).not.toContain(dir);

    const file = await fetch(`${baseUrl}/api/erp/invoice-intakes/${intake.id}/file`, { headers });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toMatch(/^inline; filename="invoice-[A-Za-z0-9-]+\.pdf"$/);
    expect(file.headers.get("content-disposition")).not.toContain(dir);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF);

    expect((await upload(set.id, new Blob([PDF], { type: "application/pdf" }), "again.pdf")).status).toBe(409);
    const cancel = await fetch(`${baseUrl}/api/erp/invoice-intakes/${intake.id}/cancel`, { method: "POST", headers });
    expect((await cancel.json()).status).toBe("cancelled");
    expect((await fetch(`${baseUrl}/api/erp/invoice-intakes/${intake.id}/file`, { headers })).status).toBe(200);
  });

  it("rejects bad uploads with generic errors", async () => {
    const set = await createSet();
    const mismatch = await upload(set.id, new Blob([PDF], { type: "image/png" }), "x.png");
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(await mismatch.json())).not.toContain(dir);
    expect((await upload(set.id, new Blob([PDF], { type: "application/pdf" }), "x.pdf", "bogus")).status).toBe(400);
    const tooBig = await upload(set.id, new Blob([PDF, Buffer.alloc(5 * 1024 * 1024)], { type: "application/pdf" }), "big.pdf");
    expect(tooBig.status).toBe(413);
    const noFile = await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${set.id}/files`, { method: "POST", headers, body: (() => { const f = new FormData(); f.append("invoiceType", "auction"); return f; })() });
    expect(noFile.status).toBe(400);
  });

  it("PHASE-2B: extract fails closed with a generic 503 when AI_INTAKE_PROVIDER is not openai, leaving the intake uploaded", async () => {
    const previous = process.env.AI_INTAKE_PROVIDER;
    process.env.AI_INTAKE_PROVIDER = "mock";
    try {
      const set = await createSet();
      const intake = await (await upload(set.id, new Blob([PDF, "2b-extract"], { type: "application/pdf" }), "a.pdf")).json();
      const res = await fetch(`${baseUrl}/api/erp/invoice-intakes/${intake.id}/extract`, { method: "POST", headers });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "AI invoice reading is not available. Enter the invoice values manually.", code: "INVOICE_EXTRACTION_UNAVAILABLE" });
      const detail = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${set.id}`, { headers })).json();
      expect(detail.intakes[0]).toMatchObject({ status: "uploaded", review: null });
      expect((await fetch(`${baseUrl}/api/erp/invoice-intakes/missing/extract`, { method: "POST", headers })).status).toBe(404);
      for (const url of ["/invoice-intakes/x/extract", "/invoice-intakes/x/review"]) {
        expect((await fetch(`${baseUrl}/api/erp${url}`, { method: "POST", headers: { "X-Noctella-ERP-Client-Version": "0.1.0" } })).status).toBe(401);
      }
    } finally {
      if (previous === undefined) delete process.env.AI_INTAKE_PROVIDER; else process.env.AI_INTAKE_PROVIDER = previous;
    }
  });

  it("PHASE-2B: review validates the body, returns 409 with checks on a blocked confirm, and never exposes a path", async () => {
    const { invoiceIntakes } = await import("../src/db/schema.sqlite");
    const { eq } = await import("drizzle-orm");
    const set = await createSet();
    const intake = await (await upload(set.id, new Blob([PDF, "2b-review"], { type: "application/pdf" }), "a.pdf")).json();
    const review = (body: unknown) => fetch(`${baseUrl}/api/erp/invoice-intakes/${intake.id}/review`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    expect((await review({ edits: {}, confirm: true })).status).toBe(409); // not extracted yet
    const v = (value: unknown) => ({ value, evidence: value === null ? null : String(value), confidence: 0.9 });
    const output = {
      invoiceType: v("auction"), supplierName: v("House"), supplierVatNumber: v(null), platform: v(null), invoiceNumber: v("227552"),
      issueDate: v(null), dueDate: v(null), paidDate: v(null), currency: v("SEK"), vatNote: v(null), reverseCharge: v(null), total: v(1198),
      lots: [{ lotNumber: v("5332164"), title: v("KAMEROR"), itemCountHint: v(8), amount: v(945) }],
      fees: [{ type: v("hammer_fee"), label: v("Hammer fee"), amount: v(64), percent: v(null), lotNumber: v(null) }, { type: v("buyer_premium"), label: v("Buyer's premium"), amount: v(189), percent: v(20), lotNumber: v(null) }],
    };
    await harnessDb.update(invoiceIntakes).set({ status: "extracted", extractionJson: JSON.stringify({ output, checks: [], model: "m", extractedAt: "2026-11-02T00:00:00.000Z" }) }).where(eq(invoiceIntakes.id, intake.id));

    expect((await review({ edits: { invoiceType: "shipping" } })).status).toBe(400);
    expect((await review({ edits: { issueDate: "02.11.2026" } })).status).toBe(400);
    expect((await review({ edits: {}, extra: 1 })).status).toBe(400);

    const blocked = await review({ edits: { total: 1199 }, confirm: true });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.code).toBe("INVOICE_REVIEW_CHECKS_FAILED");
    expect(blockedBody.checks.find((c: any) => c.code === "TOTAL_MISMATCH")).toMatchObject({ ok: false });

    const ok = await review({ edits: { invoiceType: "transport", lots: [], fees: [{ type: "transport", label: "Home delivery: 5332164", amount: 300, percent: null, lotNumber: "5332164" }], total: 300 }, confirm: true });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(dir);
    expect(text).not.toContain("fileRelativePath");
    expect(JSON.parse(text)).toMatchObject({ status: "reviewed", invoiceType: "transport", totalOriginal: 300 });
  });
});
