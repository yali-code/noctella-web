import type {
  CanonicalProductProposal,
  CanonicalProductProposalGenerationRequest,
  CanonicalProductProposalGenerationResult,
  CanonicalProductProposalProvider,
} from "./types";

const MOCK_CANONICAL_PRODUCT_PROPOSAL_PROVIDER_NAME = "mock-canonical-product-ai-v1";
const STOPWORDS = new Set(["the", "and", "with", "for", "from", "this", "that"]);

function titleWords(title: string): string[] {
  return title
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9']/g, ""))
    .filter((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()));
}

/**
 * Sprint 148: fully local, deterministic mock. No network call, no fetch, no SDK dependency, no
 * paid API. Identical input always produces an identical result. Independent of ai-intake/*,
 * marketplace-prep/*, and sales-enrichment/* - no import, no shared logic, no shared field shape.
 *
 * Mirrors ai-intake/mockProvider.ts's own honest-about-its-limits convention exactly: this mock
 * has no real vision capability, so it NEVER reads photo bytes (photoReader.read is never called)
 * and NEVER returns a Physical Information suggestion - metadata.imagesUsedCount is always 0,
 * which sanitizeCanonicalPhysicalSuggestion (./openAiOutputSchema.ts) already treats as "no
 * evidence, omit every physical field" if this provider's output were ever run through it (it
 * isn't - this provider constructs its own already-empty physical fields directly, for the same
 * reason). Product Details are only ever derived from already-supplied canonical context - a
 * brand/model/manufacturer/countryOfOrigin/period this provider has no independent source for is
 * always left undefined, never guessed. Description/Product Story are the only fields this mock
 * will propose text for when currently blank, using a plain, clearly-templated composition of
 * already-known context (title/materials/condition/brand) - never an invented fact.
 */
export class MockCanonicalProductProposalProvider implements CanonicalProductProposalProvider {
  async generate(request: CanonicalProductProposalGenerationRequest): Promise<CanonicalProductProposalGenerationResult> {
    const { context } = request;
    const proposal: CanonicalProductProposal = {};

    if (!context.description) {
      const parts = [
        context.brand ? `A ${context.brand} piece` : "A notable piece",
        context.materials ? `crafted from ${context.materials}` : undefined,
        context.condition ? `in ${context.condition.toLowerCase()} condition` : undefined,
      ].filter((p): p is string => Boolean(p));
      proposal.suggestedDescription = parts.length > 0 ? `${parts.join(", ")}.` : undefined;
    }

    if (!context.productStory && context.period) {
      proposal.suggestedProductStory = `Dating from ${context.period}${context.countryOfOrigin ? `, originating in ${context.countryOfOrigin}` : ""}.`;
    }

    const tagWords = titleWords(context.title).slice(0, 2);
    proposal.suggestedMarketingTags = tagWords.length > 0 ? tagWords.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : undefined;

    // No real vision capability - never proposes brand/model/manufacturer/countryOfOrigin/period/
    // materials/condition/conditionDescription (would require independently sourcing a fact this
    // mock has no basis for), and never proposes any Physical Information field.

    return {
      proposal,
      metadata: {
        providerName: MOCK_CANONICAL_PRODUCT_PROPOSAL_PROVIDER_NAME,
        promptVersion: request.prompt.version,
        imagesUsedCount: 0,
      },
    };
  }
}
