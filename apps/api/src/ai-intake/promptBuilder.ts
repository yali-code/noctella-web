import type { AiIntakeGenerationContext, AiIntakePrompt, AiIntakePromptBuilder } from "./types";

/**
 * Sprint 92: bump only when the prompt's content/shape actually changes.
 * Exported standalone (not embedded in the prompt text) so callers can
 * report it without parsing the prompt itself.
 */
export const AI_INTAKE_PROMPT_VERSION = "sprint92-v1";

/**
 * Deterministic, pure, provider-independent: the same context always
 * produces byte-identical prompt fields. No I/O, no Date.now(), no
 * randomness, no Product/Inventory/marketplace/publishing vocabulary.
 */
export class DeterministicAiIntakePromptBuilder implements AiIntakePromptBuilder {
  build(context: AiIntakeGenerationContext): AiIntakePrompt {
    const systemPrompt =
      "You are assisting with a draft listing proposal for a staged AI intake. " +
      "Use only the provided intake and photo metadata. Do not invent details beyond what is given.";

    const userPromptLines = [
      `Intake ID: ${context.intakeId}`,
      `Staged photo count: ${context.photos.length}`,
      context.photos.length > 0
        ? `Staged photo filenames: ${context.photos.map((photo) => photo.originalFilename).join(", ")}`
        : "No staged photos are attached to this intake.",
    ];

    return {
      version: AI_INTAKE_PROMPT_VERSION,
      systemPrompt,
      userPrompt: userPromptLines.join("\n"),
    };
  }
}
