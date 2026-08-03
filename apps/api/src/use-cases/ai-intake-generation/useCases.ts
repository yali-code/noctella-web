import type { AiIntakePhoto, AiProductIntake } from "@noctella/shared";
import { buildAiIntakeGenerationContext } from "../../ai-intake/context";
import { DeterministicAiIntakePromptBuilder } from "../../ai-intake/promptBuilder";
import type {
  AiIntakeGenerationProvider,
  AiIntakeGenerationResult,
  AiIntakePhotoReader,
  AiIntakePromptBuilder,
} from "../../ai-intake/types";

export interface GenerateAiIntakeProposalInput {
  intake: AiProductIntake;
  photos: AiIntakePhoto[];
}

/**
 * Sprint 92 (exact-review correction): pure orchestration - no database
 * access here. The caller (services/aiIntakeGeneration.ts) is responsible
 * for fetching intake/photos via the existing canonical
 * getIntakeById/listIntakePhotos services, for the Open-status check, and
 * for constructing an intake-scoped photoReader (via
 * services/aiIntakePhotoStorageKeyResolver.ts) - photoReader is now a
 * required parameter rather than a DB-free default, since a real reader
 * needs database access to resolve a photo id to a storage key. This use
 * case only builds the context, builds the prompt, and invokes the
 * injected provider - no DB write anywhere.
 */
export async function generateAiIntakeProposalUseCase(
  provider: AiIntakeGenerationProvider,
  input: GenerateAiIntakeProposalInput,
  photoReader: AiIntakePhotoReader,
  promptBuilder: AiIntakePromptBuilder = new DeterministicAiIntakePromptBuilder(),
): Promise<AiIntakeGenerationResult> {
  const context = buildAiIntakeGenerationContext(input.intake, input.photos);
  const prompt = promptBuilder.build(context);
  return provider.generate({ context, prompt, photoReader });
}
