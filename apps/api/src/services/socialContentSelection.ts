import type { DbClient } from "../db/client";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { selectNextSocialContentProduct } from "../use-cases/social-content/selection";

export function selectNextSocialContentCandidate(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  return selectNextSocialContentProduct(createSocialContentRepository(db, driver));
}
