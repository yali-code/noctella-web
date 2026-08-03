import { AiProductIntakeStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { BadRequestError } from "./errors";
import { getIntakeById } from "./aiProductIntakes";
import { listIntakePhotos } from "./aiIntakePhotos";
import { createIntakeScopedPhotoStorageKeyResolver } from "./aiIntakePhotoStorageKeyResolver";
import { LocalAiIntakePhotoReader } from "../ai-intake/photoReader";
import { MockAiIntakeGenerationProvider } from "../ai-intake/mockProvider";
import type { AiIntakeGenerationProvider, AiIntakeGenerationResult } from "../ai-intake/types";
import { generateAiIntakeProposalUseCase } from "../use-cases/ai-intake-generation/useCases";

/** Swappable provider - Sprint 92 wires only the local mock, no external API. */
const defaultProvider: AiIntakeGenerationProvider = new MockAiIntakeGenerationProvider();

/**
 * Sprint 92 (exact-review correction): no DB write anywhere in this
 * function. getIntakeById and listIntakePhotos are the existing canonical
 * Sprint 90/91 services (no repository query is duplicated) -
 * listIntakePhotos performs its own existence check internally, so the
 * explicit getIntakeById call below is for the Open-status check
 * specifically, mirroring the same composition already used by
 * services/aiIntakePhotos.ts's own upload/list/delete functions.
 *
 * The photoReader constructed here is scoped to this one intakeId via
 * createIntakeScopedPhotoStorageKeyResolver, which resolves a photo id to a
 * storage key only through the existing canonical
 * AiIntakePhotoRepository.findByIdAndIntake - cross-intake photo resolution
 * is not possible.
 */
export async function generateIntakeProposal(
  db: DbClient,
  intakeId: string,
  provider: AiIntakeGenerationProvider = defaultProvider,
): Promise<AiIntakeGenerationResult> {
  const intake = await getIntakeById(db, intakeId); // throws NotFoundError if missing
  if (intake.status !== AiProductIntakeStatus.Open) {
    throw new BadRequestError(`Only an Open intake can generate a proposal (current status: "${intake.status}")`);
  }

  const photos = await listIntakePhotos(db, intakeId);
  const photoReader = new LocalAiIntakePhotoReader(createIntakeScopedPhotoStorageKeyResolver(db, intakeId));
  return generateAiIntakeProposalUseCase(provider, { intake, photos }, photoReader);
}
