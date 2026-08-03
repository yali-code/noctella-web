import type { AiIntakeGenerationProvider, AiIntakeGenerationRequest, AiIntakeGenerationResult } from "./types";

/** Stable provider name reported in every result's metadata. */
const MOCK_INTAKE_PROVIDER_NAME = "mock-intake-v1";

/**
 * Sprint 92: fully local, deterministic mock. No network call, no fetch, no
 * SDK dependency, no paid API, and - unlike a real future provider - never
 * calls request.photoReader.read(); identical input always produces an
 * identical result. Independent of apps/api/src/ai/mockProvider.ts (no
 * import, no shared logic, no shared field shape).
 */
export class MockAiIntakeGenerationProvider implements AiIntakeGenerationProvider {
  async generate(request: AiIntakeGenerationRequest): Promise<AiIntakeGenerationResult> {
    const { context } = request;
    const photoCount = context.photos.length;

    const suggestedTitle =
      photoCount > 0 ? `Staged intake with ${photoCount} photo${photoCount === 1 ? "" : "s"}` : "Staged intake with no photos yet";

    const suggestedDescription =
      photoCount > 0
        ? `A draft listing proposal generated from ${photoCount} staged photo${photoCount === 1 ? "" : "s"}: ${context.photos.map((photo) => photo.originalFilename).join(", ")}.`
        : "A draft listing proposal generated from an intake with no staged photos yet.";

    const suggestedKeywords = context.photos
      .map((photo) => photo.originalFilename.replace(/\.[^.]+$/, "").toLowerCase())
      .filter((keyword) => keyword.length > 0);

    return {
      proposal: {
        suggestedTitle,
        suggestedDescription,
        suggestedKeywords: suggestedKeywords.length > 0 ? suggestedKeywords : undefined,
        confidenceScore: 0.5,
      },
      metadata: {
        providerName: MOCK_INTAKE_PROVIDER_NAME,
        promptVersion: request.prompt.version,
      },
    };
  }
}
