import cors from "cors";
import express from "express";
import aiRouter from "./routes/ai";
import aiDraftsRouter from "./routes/aiDrafts";
import analyticsRouter from "./routes/analytics";
import categoriesRouter from "./routes/categories";
import collectionsRouter from "./routes/collections";
import customersRouter from "./routes/customers";
import erpRouter from "./routes/erp";
import marketplacesRouter from "./routes/marketplaces";
import marketplaceAdminRouter from "./routes/marketplaceAdmin";
import marketplaceSyncWebhookRouter from "./routes/marketplaceSync";
import liveVisitorsRouter from "./routes/liveVisitors";
import offersRouter from "./routes/offers";
import ordersRouter from "./routes/orders";
import paymentsRouter from "./routes/payments";
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
import { productPhotoStaticPath, productPhotoStaticRoot } from "./services/photoStorage";
import { seedInitialCategoriesIfEmpty } from "./services/categories";
import { enqueueChannelStockSync, enqueueProductStockSync } from "./services/stockSync";
import { enqueueJob } from "./services/backgroundJobs";
import { BackgroundJobType } from "@noctella/shared";
import { eq } from "drizzle-orm";
import { externalListings } from "./db/schema";

const app = express();
const port = process.env.API_PORT ?? 4000;

app.use(cors());
app.use("/api/webhooks", marketplaceSyncWebhookRouter);
app.use(express.json());
app.use(productPhotoStaticPath, express.static(productPhotoStaticRoot));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Sprint 2/3/4/7A: products, categories, collections, ai-drafts, the public
// storefront read endpoints, offers, and order read persistence are now functional (SQLite +
// Drizzle). Remaining routers are still Sprint 1 placeholders awaiting real
// ERP sync and business logic in later sprints.
app.use("/api/erp", erpRouter);
app.use("/api/ai", aiRouter);
app.use("/api/ai-drafts", aiDraftsRouter);
app.use("/api/products", productsRouter);
app.use("/api/publish-jobs", publishJobsRouter);
app.use("/api/background-jobs", backgroundJobsRouter);
app.use("/api/stock-sync", stockSyncRouter);
app.use("/api/marketplace-stock-sync", stockSyncRouter);
app.use("/api/categories", categoriesRouter);
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
app.post("/api/products/:id/stock-sync", async (req, res, next) => { try { res.json({ jobs: await enqueueProductStockSync(db, req.params.id, "manual") }); } catch (e) { next(e); } });
app.post("/api/external-listings/:id/stock-sync", async (req, res, next) => { try { const [listing] = await db.select().from(externalListings).where(eq(externalListings.id, req.params.id)); if (!listing) return res.status(404).json({ error: "External listing not found" }); res.json(await enqueueJob(db, { type: BackgroundJobType.StockSyncListing, channel: listing.channel, productId: listing.productId, externalListingId: listing.id, payload: { externalListingId: listing.id }, idempotencyKey: `stock:manual:${listing.id}:${new Date().toISOString()}` })); } catch (e) { next(e); } });
app.post("/api/marketplaces/:channel/stock-sync", async (req, res, next) => { try { res.json(await enqueueChannelStockSync(db, req.params.channel)); } catch (e) { next(e); } });
app.post("/api/marketplaces/stock-sync/all", async (req, res, next) => { try { res.json({ jobs: await Promise.all([enqueueChannelStockSync(db, "ebay"), enqueueChannelStockSync(db, "etsy")]) }); } catch (e) { next(e); } });
app.use("/api/marketplaces", marketplacesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api", marketplaceAdminRouter);
app.use("/api/public/products", publicProductsRouter);
app.use("/api/public/categories", publicCategoriesRouter);
app.use("/api/public/collections", publicCollectionsRouter);

seedInitialCategoriesIfEmpty(db).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to seed initial categories", err);
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Noctella API listening on port ${port}`);
});
