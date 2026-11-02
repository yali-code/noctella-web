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
});
