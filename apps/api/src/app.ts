import cors from "cors";
import express from "express";
import aiRouter from "./routes/ai";
import aiDraftsRouter from "./routes/aiDrafts";
import aiProductIntakesRouter from "./routes/aiProductIntakes";
import analyticsRouter from "./routes/analytics";
import authRouter from "./routes/auth";
import categoriesRouter from "./routes/categories";
import shippingMethodsRouter from "./routes/shippingMethods";
import collectionsRouter from "./routes/collections";
import customersRouter from "./routes/customers";
import databaseAdminRouter from "./routes/databaseAdmin";
import { createDatabaseBackupRouter } from "./routes/databaseBackup";
import { createProductPhotoBackupRouter } from "./routes/productPhotoBackup";
import erpRouter from "./routes/erp";
import marketplacesRouter from "./routes/marketplaces";
import marketplaceAdminRouter from "./routes/marketplaceAdmin";
import marketplaceSyncWebhookRouter from "./routes/marketplaceSync";
import stripeWebhookRouter from "./routes/stripeWebhook";
import liveVisitorsRouter from "./routes/liveVisitors";
import offersRouter from "./routes/offers";
import offersPublicRouter from "./routes/offersPublic";
import ordersRouter from "./routes/orders";
import ordersPublicRouter from "./routes/ordersPublic";
import paymentsRouter from "./routes/payments";
import paymentsPublicRouter from "./routes/paymentsPublic";
import publishJobsRouter from "./routes/publishJobs";
import backgroundJobsRouter from "./routes/backgroundJobs";
import stockSyncRouter from "./routes/stockSync";
import productsRouter from "./routes/products";
import publicCategoriesRouter from "./routes/publicCategories";
import publicCollectionsRouter from "./routes/publicCollections";
import publicProductsRouter from "./routes/publicProducts";
import settingsRouter from "./routes/settings";
import stockMovementsRouter from "./routes/stockMovements";
import shipmentsRouter from "./routes/shipments";
import returnsRouter from "./routes/returns";
import { db } from "./db/client";
import { getReadiness } from "./services/readiness";
import { productPhotoStaticPath, productPhotoStaticRoot } from "./services/photoStorage";
import { enqueueChannelStockSync, enqueueProductStockSync } from "./services/stockSync";
import { enqueueJob, runDueJobs } from "./services/backgroundJobs";
import { dispatchDueProductPhotoOutboxEvents } from "./services/productPhotoOutboxDispatcher";
import { dispatchDueSalesInvoiceOutboxEvents } from "./services/salesInvoiceOutbox";
import { runAiIntakeCleanupForScheduler, MAX_CLEANUP_BATCH_SIZE } from "./services/aiIntakeCleanup";
import { runDatabaseBackup } from "./services/databaseBackup";
import { runProductPhotoBackup } from "./services/productPhotoBackup";
import { BackgroundJobType } from "@noctella/shared";
import { eq } from "drizzle-orm";
import { externalListings } from "./db/schema";
import { createRequireAuth, requirePermission } from "./auth/permissions";
import { requireAdminOriginForMutations } from "./auth/csrf";
import { requireSchedulerAuth } from "./auth/machineAuth";
import { parseConfiguredOrigins } from "./auth/originAllowlist";

/**
 * Sprint 64B: split out of index.ts (which now only imports this and calls listen()) so the
 * fully-wired app - including the real middleware/route mount order - can be exercised directly
 * in tests via supertest, without binding a real network port or running startup side effects
 * (seeding lives in index.ts only).
 */
const app = express();
/**
 * Sprint 135: trust exactly one reverse-proxy hop (Render's own edge), not the entire
 * X-Forwarded-For chain (`true` would let a client forge its own apparent IP by prepending
 * arbitrary values to that header). This is the narrow, correct setting for the approved
 * single-reverse-proxy Render topology, and is what makes `req.ip` (consumed by the Sprint 135
 * COD order-creation rate limiter below and by the existing Sprint 64B login rate limiter in
 * services/adminAuth.ts) resolve to the real client IP instead of Render's own proxy address.
 */
app.set("trust proxy", 1);
const requireAuth = createRequireAuth(db);

/**
 * Explicit origin allowlist (ADMIN_APP_ORIGIN + STOREFRONT_APP_ORIGIN, each comma-separated) with
 * credentials:true, replacing the previous wide-open cors(). A request with no Origin header
 * (server-to-server calls, webhooks, curl, most test clients) is allowed through unmodified -
 * CORS only ever matters for browser-issued requests; everything else never consults it.
 * Sprint 64C: STOREFRONT_APP_ORIGIN added alongside ADMIN_APP_ORIGIN - the guest-facing
 * storefront calls this API cross-origin (anonymous, no admin session) for checkout, so its
 * origin must be allowlisted too or the browser blocks the response even once the route itself
 * is correctly made public.
 */
const allowedAppOrigins = [
  ...parseConfiguredOrigins(process.env.ADMIN_APP_ORIGIN),
  ...parseConfiguredOrigins(process.env.STOREFRONT_APP_ORIGIN),
];
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedAppOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));

// PUBLIC: marketplace webhooks verify their own signature internally; mounted before
// express.json() so they can read the raw request body for that verification.
app.use("/api/webhooks/stripe", stripeWebhookRouter);
app.use("/api/webhooks", marketplaceSyncWebhookRouter);
app.use(express.json());
// PUBLIC: product photos back both the admin app and the public storefront.
app.use(productPhotoStaticPath, express.static(productPhotoStaticRoot));

// PUBLIC: process liveness only - proves the Node process is up and Express is accepting
// connections. Does not check the database, migrations, or any business configuration.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Sprint 135: PUBLIC business-readiness signal, distinct from /health above. Answers "can this
 * deployment safely serve real COD production traffic right now" - not process liveness. Never
 * mutates state; never exposes actual environment values, shipping-method labels/countries/
 * profiles/rates, or database internals - only booleans (see use-cases/readiness/useCases.ts).
 */
app.get("/ready", async (_req, res) => {
  try {
    const result = await getReadiness(db);
    res.status(result.ready ? 200 : 503).json({ status: result.ready ? "ready" : "not_ready", checks: result.checks });
  } catch {
    res.status(503).json({ status: "not_ready", checks: null });
  }
});

// PUBLIC: storefront guest-facing read endpoints.
app.use("/api/public/products", publicProductsRouter);
app.use("/api/public/categories", publicCategoriesRouter);
app.use("/api/public/collections", publicCollectionsRouter);

// PUBLIC: login only. /logout and /me require requireAuth internally (see routes/auth.ts) -
// this router can't be uniformly gated at the mount level since it mixes public and protected.
app.use("/api/auth", authRouter);

// PUBLIC: guest checkout, called directly by the anonymous storefront (no admin session).
// Sprint 64C: split out of the administrative orders/payments routers (mounted below, behind
// requireAuth) so only these exact mutation routes are reachable without an admin session -
// the rest of the orders/payments surface stays admin-only.
app.use("/api/orders", ordersPublicRouter);
app.use("/api/payments", paymentsPublicRouter);
// PUBLIC: guest "Make an Offer" submission, called directly by the anonymous storefront (no
// admin session). Sprint 65: same split as orders/payments above - offers.ts (mounted below,
// behind requireAuth) retains every administrative offer route.
app.use("/api/offers", offersPublicRouter);

// MACHINE AUTHENTICATED: ERP integration clients authenticate via requireErp inside erpRouter.
app.use("/api/erp", erpRouter);

// MACHINE AUTHENTICATED: scheduler-triggered execution, independent of admin sessions and of
// the ERP integration key. Mounted before the admin session gate below - a scheduler must never
// need an admin session cookie.
app.post("/api/background-jobs/run", requireSchedulerAuth, async (req, res, next) => {
  try {
    const workerId = String(req.body?.workerId ?? "scheduler");
    const batchSize = Number(req.body?.batchSize ?? 10);
    const processed = await runDueJobs(db, workerId, batchSize);
    // Sprint 71: reuses this same scheduler trigger for the product-photo outbox (promotion,
    // delete, temp-cleanup) instead of adding a second cron/endpoint for it.
    const photoOutboxResults = await dispatchDueProductPhotoOutboxEvents(db, workerId, batchSize);
    // Sprint 79 correction: same reuse for the durable Sales Invoice Draft outbox — the post-commit
    // dispatch attempt in services/orders.ts is only a best-effort responsiveness optimization;
    // this scheduled sweep is what actually guarantees eventual delivery (retries, dead-lettering).
    const salesInvoiceOutboxResults = await dispatchDueSalesInvoiceOutboxEvents(db, workerId, batchSize);
    // Sprint 96: same reuse for AI intake staged-photo retention cleanup and orphan-file recovery -
    // never a second scheduler endpoint/cron. Cleanup has its own approved batch-size ceiling (500),
    // applied only to this call; the other three domains' own batchSize behavior above is unchanged.
    const cleanupBatchSize = Math.min(batchSize, MAX_CLEANUP_BATCH_SIZE);
    const aiIntakeCleanup = await runAiIntakeCleanupForScheduler(db, { batchSize: cleanupBatchSize });
    res.json({
      processed,
      photoOutboxProcessed: photoOutboxResults.length,
      salesInvoiceOutboxProcessed: salesInvoiceOutboxResults.length,
      aiIntakeCleanup,
    });
  } catch (e) {
    next(e);
  }
});
app.use("/api/background-jobs/database-backup", createDatabaseBackupRouter(() => runDatabaseBackup(db)));
app.use("/api/background-jobs/product-photo-backup", createProductPhotoBackupRouter(() => runProductPhotoBackup(db)));

// AUTHENTICATED ADMIN default: every route mounted below this line requires a valid admin
// session by default. A new router added below this point is protected automatically; one
// added above it is a deliberate, reviewable exception (as the three above are).
app.use(requireAdminOriginForMutations);
app.use(requireAuth);

app.use("/api", databaseAdminRouter);
app.use("/api/ai", aiRouter);
app.use("/api/ai-drafts", aiDraftsRouter);
app.use("/api/ai-product-intakes", aiProductIntakesRouter);
app.use("/api/products", productsRouter);
app.use("/api/publish-jobs", publishJobsRouter);
app.use("/api/background-jobs", backgroundJobsRouter);
app.use("/api/stock-sync", stockSyncRouter);
app.use("/api/marketplace-stock-sync", stockSyncRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/shipping-methods", shippingMethodsRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api", shipmentsRouter);
app.use("/api", returnsRouter);
app.use("/api/stock-movements", stockMovementsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/offers", offersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/live-visitors", liveVisitorsRouter);
app.post("/api/products/:id/stock-sync", requirePermission("marketplace.manage"), async (req, res, next) => { try { res.json({ jobs: await enqueueProductStockSync(db, req.params.id, "manual") }); } catch (e) { next(e); } });
app.post("/api/external-listings/:id/stock-sync", requirePermission("marketplace.manage"), async (req, res, next) => { try { const [listing] = await db.select().from(externalListings).where(eq(externalListings.id, req.params.id)); if (!listing) return res.status(404).json({ error: "External listing not found" }); res.json(await enqueueJob(db, { type: BackgroundJobType.StockSyncListing, channel: listing.channel, productId: listing.productId, externalListingId: listing.id, payload: { externalListingId: listing.id }, idempotencyKey: `stock:manual:${listing.id}:${new Date().toISOString()}` })); } catch (e) { next(e); } });
app.post("/api/marketplaces/:channel/stock-sync", requirePermission("marketplace.manage"), async (req, res, next) => { try { res.json(await enqueueChannelStockSync(db, req.params.channel)); } catch (e) { next(e); } });
app.post("/api/marketplaces/stock-sync/all", requirePermission("marketplace.manage"), async (req, res, next) => { try { res.json({ jobs: await Promise.all([enqueueChannelStockSync(db, "ebay"), enqueueChannelStockSync(db, "etsy")]) }); } catch (e) { next(e); } });
app.use("/api/marketplaces", marketplacesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api", marketplaceAdminRouter);

export default app;
