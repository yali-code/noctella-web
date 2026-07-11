const STORAGE_KEY = "noctella_cart";

export interface CartItem {
  productId: string;
  slug: string;
  title: string;
  primaryImageUrl?: string;
  eurPrice: number;
  usdPrice?: number;
  quantity: number;
  productType: string;
}

/**
 * Both Unique Item and Lot Item listings cap at quantity 1 (a Lot Item is
 * one listing sold as a single unit — not per-object inventory). Cart
 * quantity mirrors the same rule as product stock quantity.
 */
const MAX_CART_QUANTITY = 1;

function isValidCartItem(value: unknown): value is CartItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.productId === "string" &&
    typeof v.slug === "string" &&
    typeof v.title === "string" &&
    typeof v.eurPrice === "number" &&
    typeof v.quantity === "number" &&
    typeof v.productType === "string" &&
    (v.primaryImageUrl === undefined || typeof v.primaryImageUrl === "string") &&
    (v.usdPrice === undefined || typeof v.usdPrice === "number")
  );
}

/** Pure logic, no browser APIs — safe to unit test directly. */
export function addCartItem(items: CartItem[], item: CartItem): CartItem[] {
  if (items.some((i) => i.productId === item.productId)) return items;
  return [...items, { ...item, quantity: Math.min(item.quantity || 1, MAX_CART_QUANTITY) }];
}

export function removeCartItem(items: CartItem[], productId: string): CartItem[] {
  return items.filter((i) => i.productId !== productId);
}

export function clearCartItems(): CartItem[] {
  return [];
}

export function cartHasItem(items: CartItem[], productId: string): boolean {
  return items.some((i) => i.productId === productId);
}

export function cartItemCount(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

export function cartEurSubtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.eurPrice * i.quantity, 0);
}

/** Returns undefined unless every cart item has a USD price. */
export function cartUsdSubtotal(items: CartItem[]): number | undefined {
  if (items.length === 0) return undefined;
  if (items.some((i) => i.usdPrice === undefined)) return undefined;
  return items.reduce((sum, i) => sum + (i.usdPrice as number) * i.quantity, 0);
}

/** localStorage-backed wrapper — guest-only persistence, no database. */
export function getCart(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop invalid entries and any duplicate productIds (keep the first).
    const seen = new Set<string>();
    const valid: CartItem[] = [];
    for (const entry of parsed) {
      if (!isValidCartItem(entry)) continue;
      if (seen.has(entry.productId)) continue;
      seen.add(entry.productId);
      valid.push({ ...entry, quantity: Math.min(entry.quantity || 1, MAX_CART_QUANTITY) });
    }
    return valid;
  } catch {
    return [];
  }
}

function saveCart(items: CartItem[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function addToCartPersisted(item: CartItem): CartItem[] {
  const updated = addCartItem(getCart(), item);
  saveCart(updated);
  return updated;
}

export function removeFromCartPersisted(productId: string): CartItem[] {
  const updated = removeCartItem(getCart(), productId);
  saveCart(updated);
  return updated;
}

export function clearCartPersisted(): CartItem[] {
  const updated = clearCartItems();
  saveCart(updated);
  return updated;
}
