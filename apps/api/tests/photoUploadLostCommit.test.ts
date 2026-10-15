import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { productPhotos, products } from "../src/db/schema";
import { uploadProductPhoto } from "../src/services/products";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

// W1/W10: a lost COMMIT acknowledgement in the legacy upload path must never delete the bytes a
// committed product_photos row references (#396/#407 safety remediation).

const product = { id: "p1", slug: "lost-commit", sku: "SKU-LC", title: "Lost Commit", type: ProductType.UniqueItem, status: ProductStatus.Published, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 1 };
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-lost-commit-")); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

/** Synthetic storage writing real files so hashes and inodes can be proven. */
function fileStorage() {
  let n = 0;
  return {
    saveProductPhoto: vi.fn(async () => {
      n += 1;
      const filename = `legacy-${n}.webp`;
      fs.writeFileSync(path.join(root, filename), `main-${n}`);
      fs.writeFileSync(path.join(root, `legacy-${n}-thumb.webp`), `thumb-${n}`);
      return { filename, url: `/images/product-photos/${filename}`, thumbnailUrl: `/images/product-photos/legacy-${n}-thumb.webp`, mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1 };
    }),
    deleteProductPhoto: vi.fn(async (photo: { url: string; thumbnailUrl: string }) => { for (const u of [photo.url, photo.thumbnailUrl]) fs.rmSync(path.join(root, path.basename(u)), { force: true }); }),
  };
}
const proof = () => fs.readdirSync(root).sort().map((f) => { const s = fs.statSync(path.join(root, f), { bigint: true }); return `${f} ${s.ino} ${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex")}`; });

/** The real transaction runs (and commits); its acknowledgement is then "lost". */
function ackLost<T extends object>(db: T, when: "after-commit" | "before-commit"): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (when === "before-commit") throw new Error("connection lost before commit");
        const result = original.apply(target, args);
        if (result instanceof Promise) return result.then(() => { throw new Error("connection lost after commit"); });
        throw new Error("connection lost after commit");
      };
    },
  });
}

describe("legacy upload lost COMMIT acknowledgement (SQLite)", () => {
  function setup() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }); }

  it("committed row survives with its files when the acknowledgement is lost", async () => {
    const db = setup(); await db.insert(products).values(product);
    const storage = fileStorage();
    const photo = await uploadProductPhoto(ackLost(db, "after-commit") as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, storage as never);
    expect(photo.url).toBe("/images/product-photos/legacy-1.webp");
    expect(storage.deleteProductPhoto).not.toHaveBeenCalled();
    expect(fs.readdirSync(root).sort()).toEqual(["legacy-1-thumb.webp", "legacy-1.webp"]);
    expect((await db.select().from(productPhotos)).map((r) => r.url)).toEqual(["/images/product-photos/legacy-1.webp"]);
  });

  it("a provable SQLite rollback still compensates (unchanged behavior)", async () => {
    const db = setup(); await db.insert(products).values(product);
    const storage = fileStorage();
    await expect(uploadProductPhoto(ackLost(db, "before-commit") as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, storage as never)).rejects.toThrow("connection lost before commit");
    expect(storage.deleteProductPhoto).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("an unreadable database after the failure retains the files and fails closed", async () => {
    const db = setup(); await db.insert(products).values(product);
    const storage = fileStorage();
    // The database becomes unreadable from the moment the transaction fails.
    let failed = false;
    const broken = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "transaction") return () => { failed = true; throw new Error("connection lost before commit"); };
        if (prop === "select" && failed) return () => { throw new Error("database unavailable"); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const outcome = await uploadProductPhoto(broken as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, storage as never).catch((e) => e);
    expect(outcome).toMatchObject({ status: 503, code: "PHOTO_STORAGE_UNAVAILABLE" });
    expect(storage.deleteProductPhoto).not.toHaveBeenCalled();
    expect(proof()).toHaveLength(2);
  });
});

describe.skipIf(!postgresTestConfigured)("legacy upload lost COMMIT acknowledgement (PostgreSQL)", () => {
  it("committed row is kept; an unprovable rollback retains files and fails closed", async () => {
    vi.stubEnv("DATABASE_DRIVER", "postgres");
    const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql");
    try {
      await h.pool.query("INSERT INTO products(id,sku,title,slug,type,status) VALUES('p1','SKU-LC','Lost Commit','lost-commit','unique_item','published')");
      const committedStorage = fileStorage();
      const photo = await uploadProductPhoto(ackLost(h.db, "after-commit") as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, committedStorage as never);
      expect(photo.url).toBe("/images/product-photos/legacy-1.webp");
      expect(committedStorage.deleteProductPhoto).not.toHaveBeenCalled();
      const before = proof();
      const ambiguous = fileStorage();
      const outcome = await uploadProductPhoto(ackLost(h.db, "before-commit") as never, "p1", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, undefined, ambiguous as never).catch((e) => e);
      expect(outcome).toMatchObject({ status: 503, code: "PHOTO_STORAGE_UNAVAILABLE" });
      expect(ambiguous.deleteProductPhoto).not.toHaveBeenCalled();
      expect(proof().filter((p) => before.includes(p))).toEqual(before);
    } finally { await h.close(); }
  });
});
