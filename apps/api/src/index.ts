import cors from "cors";
import express from "express";
import aiRouter from "./routes/ai";
import analyticsRouter from "./routes/analytics";
import categoriesRouter from "./routes/categories";
import customersRouter from "./routes/customers";
import erpRouter from "./routes/erp";
import liveVisitorsRouter from "./routes/liveVisitors";
import offersRouter from "./routes/offers";
import ordersRouter from "./routes/orders";
import productsRouter from "./routes/products";
import settingsRouter from "./routes/settings";

const app = express();
const port = process.env.API_PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Sprint 1: route structure only. Each router is a placeholder awaiting
// real ERP sync, AI generation, and business logic in later sprints.
app.use("/api/erp", erpRouter);
app.use("/api/ai", aiRouter);
app.use("/api/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/offers", offersRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/live-visitors", liveVisitorsRouter);
app.use("/api/settings", settingsRouter);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Noctella API listening on port ${port}`);
});
