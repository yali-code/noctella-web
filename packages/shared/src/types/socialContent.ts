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
}
export interface SocialContent {
  id: string;
  platform: "instagram";
  accountLabel: "vault";
  contentType: SocialContentType;
  status: SocialContentStatus;
  caption: string;
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
}
