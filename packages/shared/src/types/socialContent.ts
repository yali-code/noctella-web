export const SOCIAL_CONTENT_TYPES = ["post", "reel", "story"] as const;
export const SOCIAL_CONTENT_STATUSES = ["draft", "ready_for_review", "approved", "rejected"] as const;
export type SocialContentType = typeof SOCIAL_CONTENT_TYPES[number];
export type SocialContentStatus = typeof SOCIAL_CONTENT_STATUSES[number];
export interface SocialMediaPhoto {
  id: string;
  productId: string;
  url: string;
  thumbnailUrl: string;
  altText: string | null;
  editorialAltText: string | null;
}
export interface SocialContent {
  id: string;
  platform: "instagram";
  accountLabel: "vault";
  contentType: SocialContentType;
  status: SocialContentStatus;
  caption: string;
  hashtags: string[] | null;
  concept: string | null;
  readonly aiProvider: string | null;
  readonly aiModel: string | null;
  readonly aiPromptVersion: string | null;
  readonly aiGeneratedAt: string | null;
  readonly aiRequestId: string | null;
  readonly aiSourceProductId: string | null;
  productId: string | null;
  product: { id: string; title: string; sku: string } | null;
  media: SocialMediaPhoto[];
  missingMediaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SocialContentDraftInput {
  contentType: SocialContentType;
  caption: string;
  productId: string | null;
  mediaIds: string[];
  hashtags?: string[];
  concept?: string | null;
  mediaEditorialAltTexts?: Array<{ photoId: string; editorialAltText: string }>;
}
