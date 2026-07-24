import app from "./app";
import { db } from "./db/client";
import { seedInitialCategoriesIfEmpty } from "./services/categories";

const port = process.env.API_PORT ?? 4000;

seedInitialCategoriesIfEmpty(db).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to seed initial categories", err);
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Noctella API listening on port ${port}`);
});
