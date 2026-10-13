import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import express from "express";
import multer from "multer";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { createProduct, uploadProductPhoto } from "../src/services/products";
import type { PhotoStorage } from "../src/services/photoStorage";

let root: string;
let storage: typeof import("../src/services/photoStorage");
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-contract-"));
  vi.stubEnv("PRODUCT_PHOTO_DIR", root);
  vi.resetModules();
  storage = await import("../src/services/photoStorage");
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("P2-2B existing contracts", () => {
  it("preserves orientation, WebP recipe dimensions, original-byte size metadata and deterministic retry bytes", async () => {
    const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#b08040" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const saved = await storage.photoStorage.saveProductPhoto({ buffer: bytes, size: bytes.length, mimetype: "image/jpeg" });
    expect(saved).toMatchObject({ width: 40, height: 80, mimeType: "image/webp", sizeBytes: bytes.length });
    const original = await readFile(path.join(root, saved.filename));
    const input = { buffer: bytes, size: bytes.length, mimetype: "image/jpeg", mainStorageKey: "product-photo.webp", thumbnailStorageKey: "product-photo-thumb.webp" };
    const first = await storage.writeDeterministicProductPhoto(input);
    expect(await storage.writeDeterministicProductPhoto(input)).toEqual(first);
    expect(await readFile(path.join(root, input.mainStorageKey))).toEqual(original);
    const different = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#ff0000" } }).png().toBuffer();
    await expect(storage.writeDeterministicProductPhoto({ ...input, buffer: different, size: different.length, mimetype: "image/png" })).rejects.toThrow("different content");
    expect(await readFile(path.join(root, input.mainStorageKey))).toEqual(original);
  });

  it("captures pre-existing multipart failure mapping before the candidate normalizes errors", async () => {
    const app = express();
    app.post("/photos", multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("photo"), (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Photo file is required" });
      res.status(201).json({ sizeBytes: req.file.size });
    });
    expect((await request(app).post("/photos")).body).toEqual({ error: "Photo file is required" });
    const extra = await request(app).post("/photos").attach("other", Buffer.from("x"), "x.jpg");
    expect(extra.status).toBe(500); expect(extra.type).toBe("text/html");
    const large = await request(app).post("/photos").attach("photo", Buffer.alloc(10 * 1024 * 1024 + 1), "x.jpg");
    expect(large.status).toBe(500); expect(large.type).toBe("text/html");
  });

  it("never compensates committed photo files when the post-commit response read fails", async () => {
    const db = createTestDb();
    const category = await createCategory(db, { name: "Contracts", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "P22B", title: "Photo Contract", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
    const fake: PhotoStorage = {
      saveProductPhoto: vi.fn(async () => ({ filename: "owned.webp", url: "/images/product-photos/owned.webp", thumbnailUrl: "/images/product-photos/owned-thumb.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1 })),
      deleteProductPhoto: vi.fn(async () => {}),
    };
    let committed = false;
    const failing = Object.create(db) as typeof db;
    failing.transaction = ((...args: any[]) => { const value = (db.transaction as any)(...args); committed = true; return value; }) as never;
    failing.select = ((...args: any[]) => { if (committed) throw new Error("postcommit read"); return (db.select as any)(...args); }) as never;
    await expect(uploadProductPhoto(failing, product.id, { buffer: Buffer.from("x"), size: 1, mimetype: "image/png" }, "front", fake)).rejects.toThrow("postcommit read");
    expect(fake.deleteProductPhoto).not.toHaveBeenCalled();
  });
});
