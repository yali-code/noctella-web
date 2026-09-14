import type { Product } from "@noctella/shared";

export interface ProductAiSeoProposal {
  seoTitle?: string;
  metaDescription?: string;
  keywords?: string[];
}

export interface PreparedProductSeo {
  seoTitle: string;
  metaDescription: string;
  keywords: string[];
  source: Readonly<Record<"seoTitle" | "metaDescription" | "keywords", "manual" | "proposal" | "canonical">>;
}

const clean = (value?: string) => value?.trim() || undefined;

export function prepareOptionalProductSeo(product: Product, proposal: ProductAiSeoProposal = {}): PreparedProductSeo {
  const manualTitle = clean(product.seoTitle);
  const manualDescription = clean(product.metaDescription);
  const manualKeywords = product.keywords?.map((value) => value.trim()).filter(Boolean);
  const proposedTitle = clean(proposal.seoTitle);
  const proposedDescription = clean(proposal.metaDescription);
  const proposedKeywords = proposal.keywords?.map((value) => value.trim()).filter(Boolean);
  return {
    seoTitle: manualTitle ?? proposedTitle ?? product.title,
    metaDescription: manualDescription ?? proposedDescription ?? clean(product.description) ?? product.title,
    keywords: manualKeywords?.length ? manualKeywords : proposedKeywords?.length ? proposedKeywords : [],
    source: {
      seoTitle: manualTitle ? "manual" : proposedTitle ? "proposal" : "canonical",
      metaDescription: manualDescription ? "manual" : proposedDescription ? "proposal" : "canonical",
      keywords: manualKeywords?.length ? "manual" : proposedKeywords?.length ? "proposal" : "canonical",
    },
  };
}
