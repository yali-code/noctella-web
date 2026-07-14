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
import liveVisitorsRouter from "./routes/liveVisitors";
import offersRouter from "./routes/offers";
import ordersRouter from "./routes/orders";
import paymentsRouter from "./routes/payments";
import publishJobsRouter from "./routes/publishJobs";
import productsRouter from "./routes/products";
import publicCategoriesRouter from "./routes/publicCategories";
import publicCollectionsRouter from "./routes/publicCollections";
import publicProductsRouter from "./routes/publicProducts";
import settingsRouter from "./routes/settings";
import stockMovementsRouter from "./routes/stockMovements";
import { db } from "./db/client";
import { productPhotoStaticPath, productPhotoStaticRoot } from "./services/photoStorage";
import { seedInitialCategoriesIfEmpty } from "./services/categories";

const app = express();
const port = process.env.API_PORT ?? 4000;

app.use(cors());
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
app.use("/api/categories", categoriesRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/stock-movements", stockMovementsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/offers", offersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/live-visitors", liveVisitorsRouter);
app.use("/api/marketplaces", marketplacesRouter);
app.use("/api/settings", settingsRouter);
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
