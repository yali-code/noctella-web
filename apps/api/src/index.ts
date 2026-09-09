import { createGracefulShutdown, resolvePort } from "./serverLifecycle";
import { ProductionConfigurationError, validateProductionApiConfig } from "./config/productionConfig";

async function start(): Promise<void> {
  // Validate before importing the database/app graph so an unsafe relative SQLite path cannot
  // create or open the wrong database before production configuration is rejected.
  validateProductionApiConfig();
  const [{ default: app }, { db, dbRuntime }, { seedInitialCategoriesIfEmpty }] = await Promise.all([
    import("./app"),
    import("./db/client"),
    import("./services/categories"),
  ]);
  const port = resolvePort();

  await seedInitialCategoriesIfEmpty(db);

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Noctella API listening on port ${port}`);
  });

  const shutdown = createGracefulShutdown({ server, dbRuntime });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

void start().catch((error: unknown) => {
  // The configuration error contract contains only a variable name and fixed reason, never its
  // value. All other startup exceptions receive a fixed message because they may contain paths,
  // credentials, or upstream payloads.
  // eslint-disable-next-line no-console
  console.error(error instanceof ProductionConfigurationError ? error.message : "API startup failed");
  process.exitCode = 1;
});
