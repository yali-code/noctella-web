import { CanonicalProductProposalProviderConfigurationError } from "../services/errors";
import { MockCanonicalProductProposalProvider } from "./mockProvider";
import { OpenAiCanonicalProductProposalProvider, type CanonicalProductProposalOpenAiProviderConfig } from "./openAiProvider";
import type { CanonicalProductProposalProvider } from "./types";

const SUPPORTED_PROVIDERS = new Set(["mock", "openai"]);
const DEFAULT_MAX_PHOTOS = 6;

/**
 * Sprint 148: env-driven selection - CANONICAL_PRODUCT_AI_PROVIDER=mock|openai. Unset or an
 * explicitly-empty value defaults to the safe local Mock provider, mirroring
 * ai-intake/providerFactory.ts's and marketplace-prep/providerFactory.ts's exact convention
 * (development/test safety takes priority). "openai" reuses the existing
 * AI_INTAKE_OPENAI_API_KEY/AI_INTAKE_OPENAI_MODEL env vars - no new secret is required (same
 * OpenAI account already configured for AI Intake/Marketplace Preparation).
 *
 * Deliberately called fresh on every generation request (a default-parameter expression, never a
 * module-load-time constant), matching this codebase's established lazy-validation-at-call-time
 * convention.
 */
export function createCanonicalProductProposalProvider(): CanonicalProductProposalProvider {
  const raw = process.env.CANONICAL_PRODUCT_AI_PROVIDER;
  const value = raw === undefined || raw === "" ? "mock" : raw;

  if (!SUPPORTED_PROVIDERS.has(value)) {
    throw new CanonicalProductProposalProviderConfigurationError(`Unsupported CANONICAL_PRODUCT_AI_PROVIDER value: "${value}"`);
  }

  if (value === "mock") return new MockCanonicalProductProposalProvider();

  return new OpenAiCanonicalProductProposalProvider(readOpenAiConfigFromEnv());
}

function readOpenAiConfigFromEnv(): CanonicalProductProposalOpenAiProviderConfig {
  const apiKey = process.env.AI_INTAKE_OPENAI_API_KEY;
  const model = process.env.AI_INTAKE_OPENAI_MODEL;

  if (!apiKey) throw new CanonicalProductProposalProviderConfigurationError("AI_INTAKE_OPENAI_API_KEY is required when CANONICAL_PRODUCT_AI_PROVIDER=openai");
  if (!model) throw new CanonicalProductProposalProviderConfigurationError("AI_INTAKE_OPENAI_MODEL is required when CANONICAL_PRODUCT_AI_PROVIDER=openai");

  return { apiKey, model };
}

/**
 * Sprint 148: the maximum number of canonical Product photos sent to the provider in one
 * generation call - a dedicated config value rather than reusing AI_INTAKE_OPENAI_MAX_PHOTOS,
 * since that variable governs a structurally different, pre-Product staged-photo population and
 * this codebase's own AI Intake convention (readOpenAiConfigFromEnv above) already establishes
 * that each provider path owns its own explicit config rather than sharing one across unrelated
 * domains. Optional (CANONICAL_PRODUCT_AI_MAX_PHOTOS) - defaults to 6, a safe, small cap; unlike
 * AI Intake's onboarding-time hard `AiIntakeProviderTooManyPhotosError`, exceeding this cap here
 * never fails Generate - context.ts (orderAndCapCanonicalProductPhotos) silently truncates to the
 * primary-first/sortOrder-ordered first N photos instead, so a Product with many photos always
 * still gets a usable canonical AI suggestion.
 */
export function readCanonicalProductAiMaxPhotos(): number {
  const raw = process.env.CANONICAL_PRODUCT_AI_MAX_PHOTOS;
  if (!raw) return DEFAULT_MAX_PHOTOS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new CanonicalProductProposalProviderConfigurationError("CANONICAL_PRODUCT_AI_MAX_PHOTOS must be a positive integer");
  }
  return value;
}
