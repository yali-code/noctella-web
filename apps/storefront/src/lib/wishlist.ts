const STORAGE_KEY = "noctella_wishlist";

/** Pure logic, no browser APIs — safe to unit test directly. */
export function addToWishlist(list: string[], productId: string): string[] {
  if (list.includes(productId)) return list;
  return [...list, productId];
}

export function removeFromWishlist(list: string[], productId: string): string[] {
  return list.filter((id) => id !== productId);
}

export function toggleWishlist(list: string[], productId: string): string[] {
  return list.includes(productId) ? removeFromWishlist(list, productId) : addToWishlist(list, productId);
}

export function isInWishlist(list: string[], productId: string): boolean {
  return list.includes(productId);
}

/** localStorage-backed wrapper — guest-only persistence, no database. */
export function getWishlistIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveWishlistIds(ids: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function toggleWishlistPersisted(productId: string): string[] {
  const updated = toggleWishlist(getWishlistIds(), productId);
  saveWishlistIds(updated);
  return updated;
}
