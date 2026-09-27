import type { DbClient } from "../db/client";
import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialGenerationProvider, type SocialGenerationProvider } from "../social-content/provider";
import { generateSocialContentUseCase } from "../use-cases/social-content/useCases";

export function generateSocialContent(db: DbClient, value: unknown, providerFactory: () => SocialGenerationProvider = createSocialGenerationProvider) {
  return generateSocialContentUseCase(createSocialContentRepository(db), value, providerFactory);
}
