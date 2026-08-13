import { SalesEnrichmentProviderConfigurationError } from "../services/errors";
import { MockSalesEnrichmentProvider } from "./mockProvider";
import { OpenAiSalesEnrichmentProvider, type SalesEnrichmentOpenAiProviderConfig } from "./openAiProvider";
import type { SalesEnrichmentProvider } from "./types";

const SUPPORTED_PROVIDERS = new Set(["mock", "openai"]);

/**
 * Sprint 140: env-driven selection - SALES_ENRICHMENT_PROVIDER=mock|openai. Unset or an
 * explicitly-empty value defaults to the safe local Mock provider, mirroring
 * marketplace-prep/providerFactory.ts's MARKETPLACE_PREP_PROVIDER convention exactly. "openai"
 * reuses the existing AI_INTAKE_OPENAI_API_KEY/AI_INTAKE_OPENAI_MODEL env vars - no new secret is
 * required (same OpenAI account already configured for AI Intake and Marketplace Preparation).
 *
 * Deliberately called fresh on every generation request (a default-parameter expression, never a
 * module-load-time constant), matching the established lazy-validation-at-call-time convention.
 */
export function createSalesEnrichmentProvider(): SalesEnrichmentProvider {
  const raw = process.env.SALES_ENRICHMENT_PROVIDER;
  const value = raw === undefined || raw === "" ? "mock" : raw;

  if (!SUPPORTED_PROVIDERS.has(value)) {
    throw new SalesEnrichmentProviderConfigurationError(`Unsupported SALES_ENRICHMENT_PROVIDER value: "${value}"`);
  }

  if (value === "mock") return new MockSalesEnrichmentProvider();

  return new OpenAiSalesEnrichmentProvider(readOpenAiConfigFromEnv());
}

function readOpenAiConfigFromEnv(): SalesEnrichmentOpenAiProviderConfig {
  const apiKey = process.env.AI_INTAKE_OPENAI_API_KEY;
  const model = process.env.AI_INTAKE_OPENAI_MODEL;

  if (!apiKey) throw new SalesEnrichmentProviderConfigurationError("AI_INTAKE_OPENAI_API_KEY is required when SALES_ENRICHMENT_PROVIDER=openai");
  if (!model) throw new SalesEnrichmentProviderConfigurationError("AI_INTAKE_OPENAI_MODEL is required when SALES_ENRICHMENT_PROVIDER=openai");

  return { apiKey, model };
}
