import { and, asc, eq, inArray, like } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { ProductWriteRepositoryBundle, SynchronousProductWriteRepository } from "./types";

const table = (schema: typeof sqliteSchema | typeof postgresSchema, name: keyof typeof sqliteSchema) => (schema as Record<string, any>)[name];
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> => value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution = "asynchronous"): Result<any[]> => execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const first = (q: any, execution: Execution = "asynchronous"): Result<any> => then(typeof q?.limit === "function" ? rows(q.limit(1), execution) : rows(q, execution), values => values[0] ?? null);
const run = (q: any, execution: Execution = "asynchronous"): Result<unknown> => execution === "synchronous" ? q.run() : Promise.resolve(q);
const bool = (v: unknown) => v === true || v === 1;

/**
 * Sprint 98: PostgreSQL code 23505, or the established SQLite driver's
 * "UNIQUE constraint failed" message form, or PostgreSQL's duplicate-key
 * message form - the same cross-dialect signals already proven by
 * repositories/ai-intake-proposal/drizzle.ts's isUniqueViolation. Kept as a
 * separate local copy here per the approved Sprint 98 architecture decision
 * (that existing helper is not extracted or modified).
 */
function isUniqueViolation(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return code === "23505" || message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint");
}

/**
 * Sprint 94 correction: the single production implementation of "does this
 * category id exist" - execution-aware so it can run as a plain async call
 * (services/products.ts's assertCategoryExists, used by POST /api/products
 * and PUT /api/products/:id) or synchronously/asynchronously against a
 * locked transaction's tx handle (use-cases/ai-intake-apply/useCases.ts).
 * Both canonical Product-creation paths call this same function - never two
 * independent expressions of the same rule.
 */
export function categoryExistsInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  categoryId: string,
  execution: Execution = "asynchronous",
): Result<boolean> {
  const categoriesTable = table(schema, "categories");
  return then(
    rows(db.select({ id: categoriesTable.id }).from(categoriesTable).where(eq(categoriesTable.id, categoryId)), execution),
    (result: any[]) => result.length > 0,
  );
}

const PRODUCT_SKU_SEQUENCE_ID = "product_sku";
const MAX_SKU_COLLISION_RETRIES = 5;

function formatProductSku(sequence: number): string {
  return `NOC-${String(sequence).padStart(6, "0")}`;
}

/**
 * Sprint 106 correction (Exact Review BLOCKER): matches exactly the
 * system-generated NOC SKU namespace formatProductSku above produces - six
 * or more digits, since padStart(6, "0") always produces at least six and a
 * sequence value exceeding 999999 legitimately produces more than six.
 * Deliberately does NOT match a shorter numeric suffix, a non-numeric
 * suffix, or any other shape - a legacy/manually-entered SKU such as
 * "NOC-ABC", "ABC-000001", or an arbitrary manually-typed value is never
 * treated as sequence evidence.
 */
const SYSTEM_SKU_PATTERN = /^NOC-(\d{6,})$/;

/** Sprint 106 correction: extracts the numeric sequence a system-generated SKU encodes, or null for anything that does not exactly match the namespace above - never an unsafe cast, never a partial/loose match. */
function extractSystemSkuSequenceNumber(sku: unknown): number | null {
  if (typeof sku !== "string") return null;
  const match = SYSTEM_SKU_PATTERN.exec(sku);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Sprint 106 correction (Exact Review BLOCKER): the highest sequence number
 * already encoded by any existing Product SKU in the system's own
 * NOC-###### namespace, regardless of whether that Product was created by
 * this allocator, by the legacy/manual Save as Draft path (sku is
 * free-text there - use-cases/ai-intake-apply/useCases.ts), or already
 * present in a pre-existing production database. A cheap `LIKE 'NOC-%'`
 * prefilter narrows the read - matching this codebase's own established
 * convention for a SKU search (e.g. services/aiDrafts.ts's
 * `like(products.sku, ...)`) - but the actual namespace-membership decision
 * is always the strict regex above, never the LIKE prefilter alone. Returns
 * 0 when no matching Product exists.
 */
function readHighestExistingSystemSkuNumberInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  execution: Execution,
): Result<number> {
  const productsTable = table(schema, "products");
  return then(
    rows(db.select({ sku: productsTable.sku }).from(productsTable).where(like(productsTable.sku, "NOC-%")), execution),
    (existingRows: any[]) => {
      let highest = 0;
      for (const row of existingRows) {
        const value = extractSystemSkuSequenceNumber(row.sku);
        if (value !== null && value > highest) highest = value;
      }
      return highest;
    },
  );
}

/**
 * Sprint 106 (correction pass - Exact Review BLOCKER): allocates the next
 * system-generated Product SKU (NOC-000001, NOC-000002, ...), reconciled on
 * every call against BOTH the persisted product_sku_sequence counter AND the
 * highest SKU number any existing Product already carries in the same
 * namespace - inside the SAME transaction as the caller's Product creation
 * (use-cases/ai-intake-stock-acceptance/useCases.ts).
 *
 * Why reconciliation happens on every call, not only once at migration time:
 * the legacy/manual Save as Draft path (use-cases/ai-intake-apply/useCases.ts)
 * accepts an arbitrary free-text sku and remains fully live - an admin can
 * create a Product with sku "NOC-000123" through that path at any time,
 * including after this allocator has already been in active use. Reconciling
 * fresh on every allocation (rather than only bootstrapping
 * product_sku_sequence once) keeps the allocator safe against that ongoing
 * possibility, not only against pre-existing historical data at upgrade
 * time - so a database that already contains any number of consecutive
 * NOC-formatted Product SKUs (whether from history or from a manual entry
 * made yesterday) can never permanently block allocation the way jumping
 * forward one collision at a time from a stale counter could.
 *
 * Never rewinds: the reconciled starting point is always
 * max(persisted next_value, highest existing matching SKU + 1) - the
 * persisted counter only ever moves forward, never backward.
 *
 * PostgreSQL cold start: the singleton counter row is created via
 * `INSERT ... ON CONFLICT (id) DO NOTHING` (the same established idempotent-
 * insert pattern already used elsewhere in this codebase - e.g.
 * services/shipment-core/*, repositories/sales-completion/postgres.ts)
 * BEFORE the `SELECT ... FOR UPDATE` - this guarantees a row always exists
 * to lock, so two concurrent first-ever allocations can never race on a raw
 * INSERT of the same primary key; the loser's insert safely resolves to a
 * no-op, and both transactions then correctly serialize on the FOR UPDATE
 * lock. SQLite: unchanged - the whole transaction callback runs
 * synchronously with zero await/Promise boundaries, so no interleaving is
 * possible regardless.
 *
 * A bounded retry loop (never more than MAX_SKU_COLLISION_RETRIES additional
 * attempts) remains as defense-in-depth beneath the reconciliation above
 * (e.g. a same-candidate collision despite the reconciled starting point);
 * products.sku's existing UNIQUE constraint remains defense-in-depth beneath
 * that, unchanged.
 */
export function allocateNextProductSkuInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  execution: Execution = "asynchronous",
): Result<string> {
  const sequenceTable = table(schema, "productSkuSequence");
  const productsTable = table(schema, "products");

  function ensureSequenceRowExists(): Result<unknown> {
    return run(db.insert(sequenceTable).values({ id: PRODUCT_SKU_SEQUENCE_ID, nextValue: 1 }).onConflictDoNothing(), execution);
  }

  function readLockedSequenceRow(): Result<Record<string, any>> {
    if (execution === "synchronous") {
      const found = db.select().from(sequenceTable).where(eq(sequenceTable.id, PRODUCT_SKU_SEQUENCE_ID)).all();
      return found[0] ?? { nextValue: 1 };
    }
    return db
      .select()
      .from(sequenceTable)
      .where(eq(sequenceTable.id, PRODUCT_SKU_SEQUENCE_ID))
      .for("update")
      .then((found: any[]) => found[0] ?? { nextValue: 1 });
  }

  function attempt(start: number, remaining: number): Result<string> {
    const candidate = formatProductSku(start);
    const nextValue = start + 1;
    return then(run(db.update(sequenceTable).set({ nextValue }).where(eq(sequenceTable.id, PRODUCT_SKU_SEQUENCE_ID)), execution), () =>
      then(
        rows(db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.sku, candidate)), execution),
        (existing: any[]) => {
          if (existing.length === 0) return candidate;
          if (remaining <= 0) {
            throw new Error("Unable to allocate a unique Product SKU after the maximum number of attempts");
          }
          return attempt(nextValue, remaining - 1);
        },
      ),
    );
  }

  return then(ensureSequenceRowExists(), () =>
    then(readLockedSequenceRow(), (row) =>
      then(readHighestExistingSystemSkuNumberInTransaction(db, schema, execution), (highestExisting) => {
        const storedNext = Number(row.nextValue);
        const start = Math.max(Number.isFinite(storedNext) ? storedNext : 1, highestExisting + 1);
        return attempt(start, MAX_SKU_COLLISION_RETRIES);
      }),
    ),
  );
}

/**
 * Sprint 95: the single production implementation of "insert one canonical
 * ProductPhoto metadata row (Processing status) and enqueue its
 * ProductPhotoPromoteRequested outbox event, together" - execution-aware, so
 * it runs correctly whether called from a synchronous SQLite transaction
 * callback or an asynchronous PostgreSQL one. Deliberately NOT built on top
 * of createDrizzleProductWriteRepositories's `photos.createMetadata` (which
 * always wraps its result in Promise.resolve(...), even on the synchronous
 * SQLite path - awaiting/then-ing that inside a synchronous SQLite
 * transaction callback would trip its "callback must stay fully synchronous"
 * guard, exactly the class of bug this codebase has repeatedly corrected).
 * Shared by uploadProductPhoto's own locked transaction and Sprint 95's
 * intake-photo-finalization transaction - never two independent expressions
 * of "how a ProductPhoto row + its promotion event are created."
 */
export function createProductPhotoWithPromotionOutboxInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  execution: Execution,
  input: { values: Record<string, unknown>; outboxEvent: Record<string, unknown> },
): Result<{ id: string }> {
  const photosTable = table(schema, "productPhotos");
  const outboxTable = table(schema, "outboxEvents");
  const normalize = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? null : v]));
  return then(
    run(db.insert(photosTable).values(normalize(input.values)), execution),
    () => then(run(db.insert(outboxTable).values(input.outboxEvent), execution), () => ({ id: String(input.values.id) })),
  );
}

/**
 * Sprint 95: reads existing canonical ProductPhoto rows for a Product,
 * execution-aware - used by intake-photo finalization to enforce "zero
 * existing ProductPhoto rows" before creating any, and to find a
 * pre-existing row at a deterministic id (a defensive inconsistent-state
 * check). Mirrors categoryExistsInTransaction's pattern exactly.
 */
export function listProductPhotosInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  execution: Execution,
  productId: string,
): Result<any[]> {
  const photosTable = table(schema, "productPhotos");
  return rows(db.select().from(photosTable).where(eq(photosTable.productId, productId)), execution);
}

/**
 * Sprint 95: reads any existing ProductPhoto rows matching the given ids,
 * regardless of product - the defensive global deterministic-id-collision
 * check required before a first finalization attempt inserts.
 */
export function findProductPhotosByIdsInTransaction(
  db: any,
  schema: typeof sqliteSchema | typeof postgresSchema,
  execution: Execution,
  ids: string[],
): Result<any[]> {
  const photosTable = table(schema, "productPhotos");
  if (ids.length === 0) return execution === "synchronous" ? [] : Promise.resolve([]);
  return rows(db.select().from(photosTable).where(inArray(photosTable.id, ids)), execution);
}

export function createDrizzleProductWriteRepositories(db: any, schema: typeof sqliteSchema | typeof postgresSchema, dialect: "sqlite" | "postgres", execution: Execution = "asynchronous"): any {
  const products = table(schema, "products"), productErpMetadata = table(schema, "productErpMetadata"), categories = table(schema, "categories"), collections = table(schema, "collections"), productPhotos = table(schema, "productPhotos");
  const normalize = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k,v]) => [k, v === undefined ? null : v]));
  const exists = (tbl: any, col: any, value: string, excludeId?: string, idCol = tbl.id) => then(rows(db.select({ id: idCol }).from(tbl).where(eq(col, value)), execution), values => values.some((r: any) => r.id !== excludeId));
  const productRepository: SynchronousProductWriteRepository = {
      /**
       * Sprint 98: catches a raw unique-constraint violation on this INSERT
       * (SKU or slug - existsBySku above only prevents the common
       * non-racing case) and reports it as `created: false` instead of
       * letting the driver exception escape uncaught. Handles both the
       * synchronous SQLite throw (caught by the try/catch, returned as a
       * plain value - never a Promise, so the synchronous transaction
       * callback stays synchronous) and the asynchronous PostgreSQL
       * rejection (caught via .then's rejection handler). Any other
       * exception is re-thrown unchanged in both branches.
       */
      create({ values }) {
        try {
          const result = run(db.insert(products).values(normalize(values)), execution);
          if (result instanceof Promise) {
            return result.then(
              () => ({ id: String(values.id), created: true }),
              (err: unknown) => {
                if (isUniqueViolation(err)) return { id: String(values.id), created: false };
                throw err;
              },
            ) as any;
          }
          return { id: String(values.id), created: true } as any;
        } catch (err) {
          if (isUniqueViolation(err)) return { id: String(values.id), created: false } as any;
          throw err;
        }
      },
      update({ id, values }) { return then(run(db.update(products).set(normalize(values)).where(eq(products.id, id)), execution), () => ({ id, updated: true })) as any; },
      existsBySku: (sku, excludeId) => exists(products, products.sku, sku, excludeId) as any,
      existsByErpReference: (erpReferenceId, excludeId) => exists(products, products.erpReferenceId, erpReferenceId, excludeId) as any,
      existsByNoctellaId(noctellaId, excludeProductId) { return exists(productErpMetadata, productErpMetadata.noctellaId, noctellaId, excludeProductId, productErpMetadata.productId) as any; },
      getVersionForUpdate(id) { return then(first(db.select({ updatedAt: products.updatedAt }).from(products).where(eq(products.id, id)), execution), row => row?.updatedAt ?? null); },
      /**
       * Sprint 88: one atomic conditional UPDATE ... WHERE id = :id AND
       * updated_at = :expectedUpdatedAt, mirroring the proven cross-dialect
       * pattern already used by repositories/inventory/drizzleCore.ts's
       * products.updateWithVersion/inventory.updateWithVersion against this
       * same table/column. Success is decided by the returned row count, not
       * by a prior application-code read-then-compare - the diagnostic read
       * below only runs after a failed update, to report which of the two
       * failure reasons occurred and the actual current token.
       */
      updateWithExpectedVersion({ id, values, expectedUpdatedAt }) { return then(rows(db.update(products).set(normalize(values)).where(and(eq(products.id, id), eq(products.updatedAt, expectedUpdatedAt))).returning(), execution), (changed: any[]) => { if (changed.length) return { id, updated: true }; return then(this.getVersionForUpdate(id), (current: string | null) => { if (!current) return { id, updated: false, conflict: { field: "id", value: id, message: "Product not found" } }; return { id, updated: false, conflict: { field: "updatedAt", value: expectedUpdatedAt, currentValue: current, message: "Product has changed since expectedUpdatedAt" } }; }); }) as any; },
      createErpMetadata(record) { return then(run(db.insert(productErpMetadata).values(normalize(record)), execution), () => undefined); },
      updateErpMetadata(productId, values) { return then(run(db.update(productErpMetadata).set(normalize(values)).where(eq(productErpMetadata.productId, productId)), execution), () => undefined); },
      getErpMetadataForUpdate(productId) { return then(first(db.select().from(productErpMetadata).where(eq(productErpMetadata.productId, productId)), execution), row => row ?? null); },
    };
  const bundle: ProductWriteRepositoryBundle = {
    products: productRepository as unknown as ProductWriteRepositoryBundle["products"],
    categories: {
      async create({ values }) { await run(db.insert(categories).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(categories).set(normalize(values)).where(eq(categories.id, id))); return { id }; },
      existsByName: (name, excludeId) => Promise.resolve(exists(categories, categories.name, name, excludeId)),
      existsBySlug: (slug, excludeId) => Promise.resolve(exists(categories, categories.slug, slug, excludeId)),
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: categories.updatedAt }).from(categories).where(eq(categories.id, id))))?.updatedAt ?? null; },
    },
    collections: {
      async create({ values }) { await run(db.insert(collections).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(collections).set(normalize(values)).where(eq(collections.id, id))); return { id }; },
      existsByName: (name, excludeId) => Promise.resolve(exists(collections, collections.name, name, excludeId)),
      existsBySlug: (slug, excludeId) => Promise.resolve(exists(collections, collections.slug, slug, excludeId)),
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: collections.updatedAt }).from(collections).where(eq(collections.id, id))))?.updatedAt ?? null; },
    },
    photos: {
      createMetadata({ values }) { const q = db.insert(productPhotos).values(normalize(values)); if (typeof q?.run === "function") q.run(); else return Promise.resolve(q).then(() => ({ id: String(values.id) })); return Promise.resolve({ id: String(values.id) }); },
      updateAltText({ productId, photoId, altText }) { const q = db.update(productPhotos).set({ altText, updatedAt: new Date().toISOString() }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); return Promise.resolve(); },
      setPrimary({ productId, photoId }) { const now = new Date().toISOString(); const q1 = db.update(productPhotos).set({ isPrimary: dialect === "postgres" ? 0 : false, updatedAt: now }).where(eq(productPhotos.productId, productId)); if (typeof q1?.run === "function") q1.run(); const q2 = db.update(productPhotos).set({ isPrimary: dialect === "postgres" ? 1 : true, updatedAt: now }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q2?.run === "function") q2.run(); return Promise.resolve(); },
      reorder({ productId, photoIds }) { const now = new Date().toISOString(); for (const [sortOrder, photoId] of photoIds.entries()) { const q = db.update(productPhotos).set({ sortOrder, updatedAt: now }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); } return Promise.resolve(); },
      deleteMetadata({ productId, photoId }) { const q = db.delete(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); return Promise.resolve(); },
      async promoteNextPrimary(productId) { const list = await this.listForUpdate(productId); if (!list.length) return; const primary = list.find((p: any) => bool(p.isPrimary)) ?? list[0]; await this.setPrimary({ productId, photoId: String(primary.id) }); },
      async updateProcessingState(photoId, state) { await run(db.update(productPhotos).set({ ...state, updatedAt: state.processingUpdatedAt }).where(eq(productPhotos.id, photoId))); },
      async updateStorageMetadata(photoId, metadata) { await run(db.update(productPhotos).set({ ...metadata, updatedAt: new Date().toISOString() }).where(eq(productPhotos.id, photoId))); },
      async getForUpdate(productId, photoId) { return (await first(db.select().from(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))))) ?? null; },
      async listForUpdate(productId) { return rows(db.select().from(productPhotos).where(eq(productPhotos.productId, productId)).orderBy(asc(productPhotos.sortOrder))); },
    },
  };
  return bundle;
}
