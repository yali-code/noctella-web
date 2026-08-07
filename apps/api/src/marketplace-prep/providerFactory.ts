import { MarketplacePreparationProviderConfigurationError } from "../services/errors";
import { MockMarketplacePreparationProvider } from "./mockProvider";
import { OpenAiMarketplacePreparationProvider, type MarketplacePreparationOpenAiProviderConfig } from "./openAiProvider";
import type { MarketplacePreparationProvider } from "./types";

const SUPPORTED_PROVIDERS = new Set(["mock", "openai"]);

/**
 * Sprint 107: env-driven selection - MARKETPLACE_PREP_PROVIDER=mock|openai.
 * Unset or an explicitly-empty value defaults to the safe local Mock
 * provider, mirroring ai-intake/providerFactory.ts's exact
 * AI_INTAKE_PROVIDER convention (development/test safety takes priority).
 * "openai" reuses the existing AI_INTAKE_OPENAI_API_KEY/AI_INTAKE_OPENAI_MODEL
 * env vars - no new secret is required (same OpenAI account already
 * configured for AI Intake; a separate MARKETPLACE_PREP_PROVIDER toggle is
 * the only new, non-secret configuration this Sprint introduces - see the
 * Sprint 107 implementation report).
 *
 * Deliberately called fresh on every generation request (a default-parameter
 * expression, never a module-load-time constant), matching
 * ai-intake/providerFactory.ts's own lazy-validation-at-call-time
 * convention - a misconfigured environment fails only the specific request
 * that needs it, never process startup.
 */
export function createMarketplacePreparationProvider(): MarketplacePreparationProvider {
  const raw = process.env.MARKETPLACE_PREP_PROVIDER;
  const value = raw === undefined || raw === "" ? "mock" : raw;

  if (!SUPPORTED_PROVIDERS.has(value)) {
    throw new MarketplacePreparationProviderConfigurationError(`Unsupported MARKETPLACE_PREP_PROVIDER value: "${value}"`);
  }

  if (value === "mock") return new MockMarketplacePreparationProvider();

  return new OpenAiMarketplacePreparationProvider(readOpenAiConfigFromEnv());
}

/**
 * Sprint 107: reuses AI_INTAKE_OPENAI_API_KEY/AI_INTAKE_OPENAI_MODEL
 * directly - both variables are required together when
 * MARKETPLACE_PREP_PROVIDER=openai, never silently defaulted. Fails closed
 * before any network request is ever made (this function never calls fetch
 * itself).
 */
function readOpenAiConfigFromEnv(): MarketplacePreparationOpenAiProviderConfig {
  const apiKey = process.env.AI_INTAKE_OPENAI_API_KEY;
  const model = process.env.AI_INTAKE_OPENAI_MODEL;

  if (!apiKey) throw new MarketplacePreparationProviderConfigurationError("AI_INTAKE_OPENAI_API_KEY is required when MARKETPLACE_PREP_PROVIDER=openai");
  if (!model) throw new MarketplacePreparationProviderConfigurationError("AI_INTAKE_OPENAI_MODEL is required when MARKETPLACE_PREP_PROVIDER=openai");

  return { apiKey, model };
}
