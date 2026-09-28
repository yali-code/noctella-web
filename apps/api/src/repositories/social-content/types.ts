import type { SocialContent, SocialContentType } from "@noctella/shared";
import type { SocialGenerationContext } from "../../social-content/provider";

// Generator effects preserve synchronous SQLite transactions and asynchronous PG queries.
export type SocialWork<T> = Generator<any, T, any>;
export interface SocialGenerationMetadata {
  aiProvider: string;
  aiModel: string;
  aiPromptVersion: string;
  aiGeneratedAt: string;
  aiRequestId: string;
  aiSourceProductId: string;
}
export interface SocialDraftInsert {
  id: string;
  platform: "instagram";
  accountLabel: "vault";
  status: "draft";
  contentType: SocialContentType;
  caption: string;
  productId: string | null;
  hashtags: string[] | null;
  concept: string | null;
  createdAt: string;
  updatedAt: string;
  version: 1;
  generation: SocialGenerationMetadata | null;
}
export interface SocialContentRepository {
  readSelectionRows(tx: any): SocialWork<Array<{ productId: string; title: string; productStatus: string; readyPhotoCount: number; contentId: string | null; contentStatus: string | null; activityAt: string | Date | null }>>;
  readGenerationContext(tx: any, productId: string): SocialWork<Pick<SocialGenerationContext, "product" | "photos"> | null>;
  transaction<T>(work: (tx: any) => SocialWork<T>): Promise<T>;
  readProduct(tx: any, id: string): SocialWork<{ id: string; updatedAt: string | Date } | undefined>;
  readPhotos(tx: any, ids: string[]): SocialWork<Array<{ id: string; productId: string; processingStatus: string }>>;
  findByRequest(tx: any, requestId: string): SocialWork<SocialContent | null>;
  insertDraft(tx: any, row: SocialDraftInsert, mediaIds: string[], altTexts?: Array<{ photoId: string; editorialAltText: string }>): SocialWork<SocialContent>;
  detail(tx: any, row: any): SocialWork<SocialContent>;
  replaceMedia(tx: any, id: string, ids: string[], altTexts?: Array<{ photoId: string; editorialAltText: string }>): SocialWork<void>;
  isRequestConflict(error: unknown): boolean;
}
