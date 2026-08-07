import { PublishChannel } from "@noctella/shared";
import type {
  MarketplacePreparationGenerationRequest,
  MarketplacePreparationGenerationResult,
  MarketplacePreparationProposal,
  MarketplacePreparationProvider,
} from "./types";

const MOCK_MARKETPLACE_PREPARATION_PROVIDER_NAME = "mock-marketplace-prep-v1";

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Sprint 107: fully local, deterministic mock. No network call, no fetch, no
 * SDK dependency, no paid API. Identical input always produces an identical
 * result. Independent of ai-intake/mockProvider.ts and ai/mockProvider.ts -
 * no import, no shared logic, no shared field shape.
 *
 * Only ever adapts/reformats values already present in the canonical
 * context - never fabricates a fact that is not already there (materials,
 * condition, brand, etc. are reused verbatim when present, never guessed).
 * Etsy style/occasion have no corresponding canonical Product field, so this
 * provider - like a real one instructed the same way - always returns them
 * undefined rather than invent a value.
 */
export class MockMarketplacePreparationProvider implements MarketplacePreparationProvider {
  async generate(request: MarketplacePreparationGenerationRequest): Promise<MarketplacePreparationGenerationResult> {
    const { context } = request;
    const proposal: MarketplacePreparationProposal = {};

    if (context.channel === PublishChannel.Ebay) {
      proposal.suggestedTitle = context.title;
      proposal.suggestedDescription = context.description;
      proposal.suggestedConditionDescription = context.conditionDescription;
      const specifics = [
        context.brand ? `Brand: ${context.brand}` : undefined,
        context.model ? `Model: ${context.model}` : undefined,
        context.materials ? `Materials: ${context.materials}` : undefined,
        context.condition ? `Condition: ${context.condition}` : undefined,
      ].filter((line): line is string => Boolean(line));
      proposal.suggestedItemSpecifics = specifics.length > 0 ? specifics.join("; ") : undefined;
    } else if (context.channel === PublishChannel.Etsy) {
      proposal.suggestedTitle = context.title;
      proposal.suggestedDescription = context.description;
      proposal.suggestedTags = context.keywords;
      proposal.suggestedMaterials = context.materials;
      // No reliable canonical-Product evidence for style/occasion - never fabricated.
      proposal.suggestedStyle = undefined;
      proposal.suggestedOccasion = undefined;
    } else {
      proposal.suggestedTitle = context.title;
      proposal.suggestedDescription = context.description;
      proposal.suggestedShortDescription = context.description ? truncate(context.description, 160) : undefined;
      proposal.suggestedSeoTitle = context.seoTitle ?? context.title;
      proposal.suggestedMetaDescription = context.metaDescription ?? (context.description ? truncate(context.description, 160) : undefined);
      proposal.suggestedFocusKeyword = context.keywords?.[0];
    }

    return {
      proposal,
      metadata: {
        providerName: MOCK_MARKETPLACE_PREPARATION_PROVIDER_NAME,
        promptVersion: request.prompt.version,
      },
    };
  }
}
