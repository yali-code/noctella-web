import app from "./app";
import { db, dbRuntime } from "./db/client";
import { seedInitialCategoriesIfEmpty } from "./services/categories";
import { createGracefulShutdown, resolvePort } from "./serverLifecycle";

const port = resolvePort();

seedInitialCategoriesIfEmpty(db).catch(() => {
  // eslint-disable-next-line no-console
  console.error("Failed to seed initial categories");
});

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Noctella API listening on port ${port}`);
});

const shutdown = createGracefulShutdown({ server, dbRuntime });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
