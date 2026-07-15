import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { outboxEvents, productPhotos, products } from "../src/db/schema";
import { PostgresUnitOfWork, SqliteUnitOfWork } from "../src/services/unitOfWork";

function dbs(){ const sqlite=new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite,{schema}) as any }; }
const product={id:"p1",sku:"sku",title:"Title",slug:"title",type:"UniqueItem",status:"Draft",priceEur:10};
const photo={id:"ph1",productId:"p1",url:"/tmp/a",thumbnailUrl:"/tmp/t",sortOrder:0,isPrimary:true,filename:"a.webp",mimeType:"image/webp",sizeBytes:1,width:1,height:1,processingStatus:"Processing"};
const event={id:"e1",eventType:"product_photo.promote_requested",aggregateType:"ProductPhoto",aggregateId:"ph1",idempotencyKey:"k1",payload:"{}",status:"Pending",attemptCount:0,maxAttempts:3,availableAt:"2026-01-01",createdAt:"2026-01-01",updatedAt:"2026-01-01"};

describe("UnitOfWork", () => {
  it("rejects unsafe async SQLite callbacks", async () => { const {db}=dbs(); await expect(new SqliteUnitOfWork(db).run(async()=>1)).rejects.toThrow("SQLITE_ASYNC"); });
  it("commits SQLite scoped work", async () => { const {db}=dbs(); await new SqliteUnitOfWork(db).run(({repositories})=>repositories.db.insert(products).values(product).run()); expect((await db.select().from(products))).toHaveLength(1); });
  it("rolls back SQLite when callback throws", async () => { const {db}=dbs(); await expect(new SqliteUnitOfWork(db).run(({repositories})=>{repositories.db.insert(products).values(product).run(); throw new Error("boom");})).rejects.toThrow("boom"); expect(await db.select().from(products)).toHaveLength(0); });
  it("commits ProductPhoto and outbox atomically", async () => { const {db}=dbs(); await db.insert(products).values(product); await new SqliteUnitOfWork(db).run(({repositories})=>{repositories.db.insert(productPhotos).values(photo).run(); repositories.db.insert(outboxEvents).values(event).run();}); expect(await db.select().from(productPhotos)).toHaveLength(1); expect(await db.select().from(outboxEvents)).toHaveLength(1); });
  it("rolls back photo when failure occurs after photo insert", async () => { const {db}=dbs(); await db.insert(products).values(product); await expect(new SqliteUnitOfWork(db).run(({repositories})=>{repositories.db.insert(productPhotos).values(photo).run(); throw new Error("after-photo");})).rejects.toThrow("after-photo"); expect(await db.select().from(productPhotos)).toHaveLength(0); expect(await db.select().from(outboxEvents)).toHaveLength(0); });
  it("rolls back both when failure occurs after outbox insert", async () => { const {db}=dbs(); await db.insert(products).values(product); await expect(new SqliteUnitOfWork(db).run(({repositories})=>{repositories.db.insert(productPhotos).values(photo).run(); repositories.db.insert(outboxEvents).values(event).run(); throw new Error("after-outbox");})).rejects.toThrow("after-outbox"); expect(await db.select().from(productPhotos)).toHaveLength(0); expect(await db.select().from(outboxEvents)).toHaveLength(0); });
  it("does not leave outbox without photo on rollback", async () => { const {db}=dbs(); await expect(new SqliteUnitOfWork(db).run(({repositories})=>{repositories.db.insert(outboxEvents).values(event).run(); throw new Error("x");})).rejects.toThrow(); expect(await db.select().from(outboxEvents)).toHaveLength(0); });
  it("uses transaction-scoped SQLite repository client", async () => { const {db}=dbs(); let scoped=false; await new SqliteUnitOfWork(db).run(({repositories})=>{ scoped = repositories.db !== db; }); expect(scoped).toBe(true); });
  it("does not execute external side effects after rollback", async () => { const side=vi.fn(); const {db}=dbs(); await expect(new SqliteUnitOfWork(db).run(()=>{ throw new Error("rollback"); })).rejects.toThrow(); expect(side).not.toHaveBeenCalled(); });
  it("commits PostgreSQL scoped work", async () => { const calls:string[]=[]; const adapter={transaction:vi.fn(async(fn:any)=>fn({calls}))}; await new PostgresUnitOfWork(adapter as any).run(({repositories}:any)=>repositories.db.calls.push("insert")); expect(calls).toEqual(["insert"]); });
  it("rolls back PostgreSQL scoped work on error", async () => { const adapter={transaction:vi.fn(async()=>{throw new Error("pg")})}; await expect(new PostgresUnitOfWork(adapter as any).run(()=>1)).rejects.toThrow("POSTGRES_TRANSACTION_FAILED"); });
  it("normalizes PostgreSQL errors with cause", async () => { const cause=new Error("detail"); const adapter={transaction:vi.fn(async()=>{throw cause})}; await expect(new PostgresUnitOfWork(adapter as any).run(()=>1)).rejects.toMatchObject({cause}); });
});
