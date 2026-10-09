/**
 * ADS-002A: pure, fail-closed eligibility projection for marketplace funnel links.
 * No database reads, tracking, redirect responses, ad spending, or provider calls.
 * The caller must obtain canonical product/stock data and authoritative external listings.
 */
export type FunnelMarketplace = "ebay" | "etsy";
export type FunnelLinkBlocker =
  | "PRODUCT_NOT_PUBLISHED"
  | "PRODUCT_PAUSED"
  | "OUT_OF_STOCK"
  | "LISTING_NOT_ACTIVE"
  | "UNSUPPORTED_MARKETPLACE"
  | "UNSAFE_LISTING_URL"
  | "LISTING_ID_MISMATCH";

export interface FunnelProductFacts {
  readonly status: string;
  readonly salePausedAt: string | null;
  /** Canonical available-for-sale quantity; unknown is not sellable. */
  readonly availableQuantity: number | null;
}

export interface FunnelListingFacts {
  readonly channel: string;
  readonly externalStatus: string;
  readonly externalListingUrl: string | null;
  /** ID provided by the marketplace adapter, never inferred from a visitor URL. */
  readonly externalListingId: string;
}

export type FunnelLinkDecision =
  | { readonly eligible: true; readonly channel: FunnelMarketplace; readonly url: string }
  | { readonly eligible: false; readonly blocker: FunnelLinkBlocker };

const EBAY_DOMAINS = new Set([
  "ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.es",
  "ebay.ca", "ebay.com.au", "ebay.at", "ebay.be", "ebay.nl", "ebay.ie",
  "ebay.ch", "ebay.pl",
]);
const ETSY_DOMAINS = new Set(["etsy.com"]);

function allowedDomain(hostname: string, roots: ReadonlySet<string>): boolean {
  return [...roots].some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function safeMarketplaceListingUrl(channel: FunnelMarketplace, candidate: string | null): string | null {
  if (!candidate || candidate.trim() !== candidate || /[\\\s]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (channel === "ebay" && !allowedDomain(host, EBAY_DOMAINS)) return null;
    if (channel === "etsy" && !allowedDomain(host, ETSY_DOMAINS)) return null;
    if (url.pathname === "/" || !url.pathname) return null;
    if (channel === "ebay" && !/^\\/itm\\/(?:[^/]+\\/)?[0-9]{5,20}\\/?$/.test(url.pathname)) return null;
    if (channel === "etsy" && !/^\\/listing\\/[0-9]{5,20}(?:\\/[^/]+)?\\/?$/.test(url.pathname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function evaluateFunnelLink(product: FunnelProductFacts, listing: FunnelListingFacts): FunnelLinkDecision {
  if (product.status !== "published") return { eligible: false, blocker: "PRODUCT_NOT_PUBLISHED" };
  if (product.salePausedAt) return { eligible: false, blocker: "PRODUCT_PAUSED" };
  if (product.availableQuantity === null || !Number.isSafeInteger(product.availableQuantity) || product.availableQuantity < 1) {
    return { eligible: false, blocker: "OUT_OF_STOCK" };
  }
  if (listing.externalStatus.toLowerCase() !== "active") return { eligible: false, blocker: "LISTING_NOT_ACTIVE" };
  const channel = listing.channel.toLowerCase();
  if (channel !== "ebay" && channel !== "etsy") return { eligible: false, blocker: "UNSUPPORTED_MARKETPLACE" };
  const url = safeMarketplaceListingUrl(channel, listing.externalListingUrl);
  if (!url) return { eligible: false, blocker: "UNSAFE_LISTING_URL" };
  const escapedId = listing.externalListingId.replace(/[.*+?^${}()|[\\]\\]/g, "\\  if (!url) return { eligible: false, blocker: "UNSAFE_LISTING_URL" };
  return { eligible: true, channel, url };");
  if (!/^[0-9]{5,20}$/.test(listing.externalListingId) ||
      !(channel === "ebay"
        ? new RegExp(`^/itm/(?:[^/]+/)?${escapedId}/?/**
 * ADS-002A: pure, fail-closed eligibility projection for marketplace funnel links.
 * No database reads, tracking, redirect responses, ad spending, or provider calls.
 * The caller must obtain canonical product/stock data and authoritative external listings.
 */
export type FunnelMarketplace = "ebay" | "etsy";
export type FunnelLinkBlocker =
  | "PRODUCT_NOT_PUBLISHED"
  | "PRODUCT_PAUSED"
  | "OUT_OF_STOCK"
  | "LISTING_NOT_ACTIVE"
  | "UNSUPPORTED_MARKETPLACE"
  | "UNSAFE_LISTING_URL"
  | "LISTING_ID_MISMATCH";

export interface FunnelProductFacts {
  readonly status: string;
  readonly salePausedAt: string | null;
  /** Canonical available-for-sale quantity; unknown is not sellable. */
  readonly availableQuantity: number | null;
}

export interface FunnelListingFacts {
  readonly channel: string;
  readonly externalStatus: string;
  readonly externalListingUrl: string | null;
  /** ID provided by the marketplace adapter, never inferred from a visitor URL. */
  readonly externalListingId: string;
}

export type FunnelLinkDecision =
  | { readonly eligible: true; readonly channel: FunnelMarketplace; readonly url: string }
  | { readonly eligible: false; readonly blocker: FunnelLinkBlocker };

const EBAY_DOMAINS = new Set([
  "ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.es",
  "ebay.ca", "ebay.com.au", "ebay.at", "ebay.be", "ebay.nl", "ebay.ie",
  "ebay.ch", "ebay.pl",
]);
const ETSY_DOMAINS = new Set(["etsy.com"]);

function allowedDomain(hostname: string, roots: ReadonlySet<string>): boolean {
  return [...roots].some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function safeMarketplaceListingUrl(channel: FunnelMarketplace, candidate: string | null): string | null {
  if (!candidate || candidate.trim() !== candidate || /[\\\s]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (channel === "ebay" && !allowedDomain(host, EBAY_DOMAINS)) return null;
    if (channel === "etsy" && !allowedDomain(host, ETSY_DOMAINS)) return null;
    if (url.pathname === "/" || !url.pathname) return null;
    if (channel === "ebay" && !/^\\/itm\\/(?:[^/]+\\/)?[0-9]{5,20}\\/?$/.test(url.pathname)) return null;
    if (channel === "etsy" && !/^\\/listing\\/[0-9]{5,20}(?:\\/[^/]+)?\\/?$/.test(url.pathname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function evaluateFunnelLink(product: FunnelProductFacts, listing: FunnelListingFacts): FunnelLinkDecision {
  if (product.status !== "published") return { eligible: false, blocker: "PRODUCT_NOT_PUBLISHED" };
  if (product.salePausedAt) return { eligible: false, blocker: "PRODUCT_PAUSED" };
  if (product.availableQuantity === null || !Number.isSafeInteger(product.availableQuantity) || product.availableQuantity < 1) {
    return { eligible: false, blocker: "OUT_OF_STOCK" };
  }
  if (listing.externalStatus.toLowerCase() !== "active") return { eligible: false, blocker: "LISTING_NOT_ACTIVE" };
  const channel = listing.channel.toLowerCase();
  if (channel !== "ebay" && channel !== "etsy") return { eligible: false, blocker: "UNSUPPORTED_MARKETPLACE" };
  const url = safeMarketplaceListingUrl(channel, listing.externalListingUrl);
).test(new URL(url).pathname)
        : new RegExp(`^/listing/${escapedId}(?:/[^/]+)?/?/**
 * ADS-002A: pure, fail-closed eligibility projection for marketplace funnel links.
 * No database reads, tracking, redirect responses, ad spending, or provider calls.
 * The caller must obtain canonical product/stock data and authoritative external listings.
 */
export type FunnelMarketplace = "ebay" | "etsy";
export type FunnelLinkBlocker =
  | "PRODUCT_NOT_PUBLISHED"
  | "PRODUCT_PAUSED"
  | "OUT_OF_STOCK"
  | "LISTING_NOT_ACTIVE"
  | "UNSUPPORTED_MARKETPLACE"
  | "UNSAFE_LISTING_URL"
  | "LISTING_ID_MISMATCH";

export interface FunnelProductFacts {
  readonly status: string;
  readonly salePausedAt: string | null;
  /** Canonical available-for-sale quantity; unknown is not sellable. */
  readonly availableQuantity: number | null;
}

export interface FunnelListingFacts {
  readonly channel: string;
  readonly externalStatus: string;
  readonly externalListingUrl: string | null;
  /** ID provided by the marketplace adapter, never inferred from a visitor URL. */
  readonly externalListingId: string;
}

export type FunnelLinkDecision =
  | { readonly eligible: true; readonly channel: FunnelMarketplace; readonly url: string }
  | { readonly eligible: false; readonly blocker: FunnelLinkBlocker };

const EBAY_DOMAINS = new Set([
  "ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.es",
  "ebay.ca", "ebay.com.au", "ebay.at", "ebay.be", "ebay.nl", "ebay.ie",
  "ebay.ch", "ebay.pl",
]);
const ETSY_DOMAINS = new Set(["etsy.com"]);

function allowedDomain(hostname: string, roots: ReadonlySet<string>): boolean {
  return [...roots].some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function safeMarketplaceListingUrl(channel: FunnelMarketplace, candidate: string | null): string | null {
  if (!candidate || candidate.trim() !== candidate || /[\\\s]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (channel === "ebay" && !allowedDomain(host, EBAY_DOMAINS)) return null;
    if (channel === "etsy" && !allowedDomain(host, ETSY_DOMAINS)) return null;
    if (url.pathname === "/" || !url.pathname) return null;
    if (channel === "ebay" && !/^\\/itm\\/(?:[^/]+\\/)?[0-9]{5,20}\\/?$/.test(url.pathname)) return null;
    if (channel === "etsy" && !/^\\/listing\\/[0-9]{5,20}(?:\\/[^/]+)?\\/?$/.test(url.pathname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function evaluateFunnelLink(product: FunnelProductFacts, listing: FunnelListingFacts): FunnelLinkDecision {
  if (product.status !== "published") return { eligible: false, blocker: "PRODUCT_NOT_PUBLISHED" };
  if (product.salePausedAt) return { eligible: false, blocker: "PRODUCT_PAUSED" };
  if (product.availableQuantity === null || !Number.isSafeInteger(product.availableQuantity) || product.availableQuantity < 1) {
    return { eligible: false, blocker: "OUT_OF_STOCK" };
  }
  if (listing.externalStatus.toLowerCase() !== "active") return { eligible: false, blocker: "LISTING_NOT_ACTIVE" };
  const channel = listing.channel.toLowerCase();
  if (channel !== "ebay" && channel !== "etsy") return { eligible: false, blocker: "UNSUPPORTED_MARKETPLACE" };
  const url = safeMarketplaceListingUrl(channel, listing.externalListingUrl);
).test(new URL(url).pathname))) {
    return { eligible: false, blocker: "LISTING_ID_MISMATCH" };
  }
  return { eligible: true, channel, url };
}
