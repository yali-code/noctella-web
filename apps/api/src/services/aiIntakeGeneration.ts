import { AiProductIntakeStatus, type AiIntakeProposalReview } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { BadRequestError } from "./errors";
import { getIntakeById } from "./aiProductIntakes";
import { listIntakePhotos } from "./aiIntakePhotos";
import { createIntakeScopedPhotoStorageKeyResolver } from "./aiIntakePhotoStorageKeyResolver";
import { toProposalReview } from "./aiIntakeProposals";
import { LocalAiIntakePhotoReader } from "../ai-intake/photoReader";
import { MockAiIntakeGenerationProvider } from "../ai-intake/mockProvider";
import type { AiIntakeGenerationProvider } from "../ai-intake/types";
import { createAiIntakeProposalRepository } from "../repositories/ai-intake-proposal/factory";
import { generateOrRegenerateProposalUseCase } from "../use-cases/ai-intake-proposal/useCases";

/** Swappable provider - Sprint 92/93 wire only the local mock, no external API. */
const defaultProvider: AiIntakeGenerationProvider = new MockAiIntakeGenerationProvider();

/**
 * Sprint 93 (mandatory correction): generation is now server-authoritative
 * and durable - a successful call persists exactly one current proposal per
 * intake and returns the persisted AiIntakeProposalReview representation
 * (the same shape GET /:id/proposal returns), never an ephemeral result.
 *
 * getIntakeById and listIntakePhotos remain the existing canonical Sprint
 * 90/91 services (no repository query is duplicated) - listIntakePhotos
 * performs its own existence check internally, so the explicit
 * getIntakeById call below is for the Open-status check specifically,
 * mirroring the same composition already used by
 * services/aiIntakePhotos.ts's own upload/list/delete functions.
 *
 * This service-layer Open-status pre-check is a fast-fail convenience only
 * - the actual persistence write independently re-verifies the intake is
 * still Open via an atomic guard inside the repository (see
 * repositories/ai-intake-proposal/drizzle.ts), so a cancellation racing
 * with generation cannot silently create or refresh a proposal.
 *
 * Regeneration (calling this again for an intake that already has a
 * proposal) is only allowed once every field decision is Pending -
 * enforced both as a fast pre-check and, independently, as part of the
 * atomic persistence write's guard - see use-cases/ai-intake-proposal/useCases.ts.
 */
export async function generateIntakeProposal(
  db: DbClient,
  intakeId: string,
  provider: AiIntakeGenerationProvider = defaultProvider,
): Promise<AiIntakeProposalReview> {
  const intake = await getIntakeById(db, intakeId); // throws NotFoundError if missing
  if (intake.status !== AiProductIntakeStatus.Open) {
    throw new BadRequestError(`Only an Open intake can generate a proposal (current status: "${intake.status}")`);
  }

  const photos = await listIntakePhotos(db, intakeId);
  const photoReader = new LocalAiIntakePhotoReader(createIntakeScopedPhotoStorageKeyResolver(db, intakeId));
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  const repository = createAiIntakeProposalRepository(driver, db);

  const row = await generateOrRegenerateProposalUseCase(repository, provider, { intake, photos }, photoReader);
  // The fingerprint just persisted was computed from the same photo read used to build the
  // generation context, so the freshly generated/regenerated proposal is never stale.
  return toProposalReview(row, false);
}
