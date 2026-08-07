import { AiIntakeProviderConfigurationError } from "../services/errors";
import { MockAiIntakeGenerationProvider } from "./mockProvider";
import { OpenAiIntakeGenerationProvider, type AiIntakeOpenAiProviderConfig } from "./openAiProvider";
import type { AiIntakeGenerationProvider } from "./types";

const SUPPORTED_PROVIDERS = new Set(["mock", "openai"]);

/**
 * Sprint 101: env-driven selection - AI_INTAKE_PROVIDER=mock|openai. Unset or
 * an explicitly-empty value defaults to the safe local Mock provider
 * (development/test safety takes priority, matching this codebase's existing
 * DATABASE_DRIVER default-to-safe-value convention: `process.env.DATABASE_DRIVER
 * || "sqlite"`, used identically in services/aiIntakeGeneration.ts,
 * aiIntakeProposals.ts, aiIntakeApply.ts). "openai" requires all three
 * AI_INTAKE_OPENAI_* variables to be present and valid; any other
 * non-empty value fails closed with AiIntakeProviderConfigurationError
 * rather than silently falling back to Mock.
 *
 * Deliberately called fresh on every generation request (see its use as a
 * default-parameter expression in services/aiIntakeGeneration.ts, never a
 * module-load-time constant) - a misconfigured environment fails only the
 * specific /generate request that needs it, matching the existing
 * lazy-validation-at-call-time convention already used by
 * services/aiIntakeCleanup.ts and services/marketplaceAdapters.ts, never a
 * process-startup crash.
 */
export function createAiIntakeGenerationProvider(): AiIntakeGenerationProvider {
  const raw = process.env.AI_INTAKE_PROVIDER;
  const value = raw === undefined || raw === "" ? "mock" : raw;

  if (!SUPPORTED_PROVIDERS.has(value)) {
    throw new AiIntakeProviderConfigurationError(`Unsupported AI_INTAKE_PROVIDER value: "${value}"`);
  }

  if (value === "mock") return new MockAiIntakeGenerationProvider();

  return new OpenAiIntakeGenerationProvider(readOpenAiConfigFromEnv());
}

/**
 * Sprint 101: all three variables are required together when
 * AI_INTAKE_PROVIDER=openai - none is silently defaulted. Fails closed
 * before any network request is ever made (this function never calls
 * fetch itself).
 */
function readOpenAiConfigFromEnv(): AiIntakeOpenAiProviderConfig {
  const apiKey = process.env.AI_INTAKE_OPENAI_API_KEY;
  const model = process.env.AI_INTAKE_OPENAI_MODEL;
  const maxPhotosRaw = process.env.AI_INTAKE_OPENAI_MAX_PHOTOS;

  if (!apiKey) throw new AiIntakeProviderConfigurationError("AI_INTAKE_OPENAI_API_KEY is required when AI_INTAKE_PROVIDER=openai");
  if (!model) throw new AiIntakeProviderConfigurationError("AI_INTAKE_OPENAI_MODEL is required when AI_INTAKE_PROVIDER=openai");
  if (!maxPhotosRaw) throw new AiIntakeProviderConfigurationError("AI_INTAKE_OPENAI_MAX_PHOTOS is required when AI_INTAKE_PROVIDER=openai");

  const maxPhotos = Number(maxPhotosRaw);
  if (!Number.isFinite(maxPhotos) || !Number.isInteger(maxPhotos) || maxPhotos < 1) {
    throw new AiIntakeProviderConfigurationError("AI_INTAKE_OPENAI_MAX_PHOTOS must be a positive integer");
  }

  return { apiKey, model, maxPhotos };
}
