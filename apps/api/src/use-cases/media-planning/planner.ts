import { z } from "zod";

/**
 * Media Planning Agent (pure): selects ERP products and their REAL stored photos for a 4-day
 * Instagram plan (4 feed posts + 1 Reel) and recommends posting times. Deterministic - the AI is
 * only used later for copy. Never invents products or images; never publishes.
 */

export const MIN_ELIGIBLE_PRODUCTS = 7;
export const PLAN_DAYS = 4;
export const FEED_POSTS = 4;
export const REEL_DAY_INDEX = 2; // third day carries both a feed post and the Reel
export const REEL_MAX_PHOTOS = 6;
export const ELIGIBLE_PRODUCT_STATUSES = ["published", "approved"] as const;
export const HASHTAGS_PER_ITEM = 5;
export const DEFAULT_PLANNER_TIMEZONE = "Europe/Sofia";

export interface PlannerPhoto { readonly id: string; readonly url: string; readonly isPrimary: boolean; readonly sortOrder: number }
export interface EligibleProduct {
  readonly id: string; readonly sku: string; readonly title: string; readonly category: string | null; readonly brand: string | null;
  readonly condition: string | null; readonly createdAt: string; readonly photos: readonly PlannerPhoto[];
}
export interface PlannerProductRow {
  readonly id: string; readonly sku: string; readonly title: string; readonly status: string; readonly stockQuantity: number; readonly salePausedAt: string | null;
  readonly category: string | null; readonly brand: string | null; readonly condition: string | null; readonly createdAt: string;
  readonly photos: readonly (PlannerPhoto & { readonly processingStatus: string | null })[];
}

/** Eligible = active inventory (published/approved), in stock, not paused, with at least one Ready stored photo. */
export function eligibleProducts(rows: readonly PlannerProductRow[], photoPathPrefix: string): EligibleProduct[] {
  return rows
    .filter((p) => (ELIGIBLE_PRODUCT_STATUSES as readonly string[]).includes(p.status) && p.stockQuantity > 0 && !p.salePausedAt)
    .map((p) => ({ ...p, photos: p.photos.filter((ph) => ph.processingStatus === "Ready" && ph.url.startsWith(`${photoPathPrefix}/`)).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)) }))
    .filter((p) => p.photos.length > 0);
}

/**
 * Category-diverse order: round-robin across categories (alphabetical), newest product first
 * within a category. The Reel product prefers the most real photos (4+), and is not reused as a
 * feed hero, so 5 distinct products appear across the plan.
 */
export function selectPlanProducts(products: readonly EligibleProduct[]): { feed: EligibleProduct[]; reel: EligibleProduct } | { blocker: string } {
  if (products.length < MIN_ELIGIBLE_PRODUCTS) return { blocker: `INSUFFICIENT_ELIGIBLE_PRODUCTS:${products.length}/${MIN_ELIGIBLE_PRODUCTS}` };
  const byCategory = new Map<string, EligibleProduct[]>();
  for (const p of [...products].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sku.localeCompare(b.sku))) {
    const key = p.category ?? "~uncategorised";
    byCategory.set(key, [...(byCategory.get(key) ?? []), p]);
  }
  const queues = [...byCategory.keys()].sort().map((k) => [...byCategory.get(k)!]);
  const ordered: EligibleProduct[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) { const next = q.shift(); if (next) ordered.push(next); }
  const reel = [...ordered].sort((a, b) => Math.min(b.photos.length, REEL_MAX_PHOTOS) - Math.min(a.photos.length, REEL_MAX_PHOTOS) || ordered.indexOf(a) - ordered.indexOf(b))[0]!;
  return { feed: ordered.filter((p) => p.id !== reel.id).slice(0, FEED_POSTS), reel };
}

// ---------------------------------------------------------------- posting times

export type TimeBasis = "TIME_RECOMMENDATION_DATA_DRIVEN" | "TIME_RECOMMENDATION_POLICY_BASED";
export interface PublishedPerformance { readonly publishedAt: string; readonly reach: number }
/** Data-driven only with enough Noctella evidence: >= 12 published media with known reach and >= 3 samples in the chosen hour. */
export const MIN_MEDIA_FOR_DATA_DRIVEN = 12;
export const MIN_SAMPLES_PER_HOUR = 3;
/** Deterministic default policy (local time): weekday evenings, weekend late morning; Reel 90 min after the feed post. */
export const DEFAULT_TIME_POLICY = Object.freeze({ weekday: { hour: 19, minute: 0 }, weekend: { hour: 11, minute: 0 }, reelOffsetMinutes: 90 });

function localHour(iso: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(iso))) % 24;
}

/** Converts a local wall-clock time in `timeZone` to a UTC ISO instant (DST-safe via Intl offsets). */
export function zonedTimeToUtc(date: string, hour: number, minute: number, timeZone: string): string {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
}

export function recommendPostingHours(evidence: readonly PublishedPerformance[], timeZone: string): { basis: TimeBasis; feedHour: number | null; detail: string } {
  if (evidence.length < MIN_MEDIA_FOR_DATA_DRIVEN) return { basis: "TIME_RECOMMENDATION_POLICY_BASED", feedHour: null, detail: `only ${evidence.length} published media with reach data (< ${MIN_MEDIA_FOR_DATA_DRIVEN})` };
  const byHour = new Map<number, number[]>();
  for (const e of evidence) byHour.set(localHour(e.publishedAt, timeZone), [...(byHour.get(localHour(e.publishedAt, timeZone)) ?? []), e.reach]);
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
  const ranked = [...byHour.entries()].filter(([, v]) => v.length >= MIN_SAMPLES_PER_HOUR).sort((a, b) => median(b[1]) - median(a[1]) || a[0] - b[0]);
  if (!ranked.length) return { basis: "TIME_RECOMMENDATION_POLICY_BASED", feedHour: null, detail: `no hour with >= ${MIN_SAMPLES_PER_HOUR} published media` };
  return { basis: "TIME_RECOMMENDATION_DATA_DRIVEN", feedHour: ranked[0]![0], detail: `highest median reach at ${ranked[0]![0]}:00 across ${ranked[0]![1].length} media` };
}

export function planDates(startDate: string, days = PLAN_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(`${startDate}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
}

/** Tomorrow's local calendar date. */
export function defaultStartDate(now: Date, timeZone: string): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return planDates(today, 2)[1]!;
}

export function slotFor(date: string, timeZone: string, recommendation: ReturnType<typeof recommendPostingHours>, kind: "feed" | "reel"): string {
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const base = recommendation.feedHour !== null ? { hour: recommendation.feedHour, minute: 0 } : weekend ? DEFAULT_TIME_POLICY.weekend : DEFAULT_TIME_POLICY.weekday;
  const minutes = base.hour * 60 + base.minute + (kind === "reel" ? DEFAULT_TIME_POLICY.reelOffsetMinutes : 0);
  return zonedTimeToUtc(date, Math.floor(minutes / 60) % 24, minutes % 60, timeZone);
}

// ---------------------------------------------------------------- copy contract + edits

export const hashtagSchema = z.string().regex(/^#[\p{L}\p{N}_]{2,60}$/u, "hashtags must look like #word");
export const planItemCopySchema = z.object({
  caption: z.string().trim().min(1).max(2200),
  hashtags: z.array(hashtagSchema).length(HASHTAGS_PER_ITEM),
  hook: z.string().trim().max(80).nullable(),
  rationale: z.string().trim().min(1).max(600),
  frameTexts: z.array(z.string().trim().max(60)).max(REEL_MAX_PHOTOS).nullable(),
  finalFrameText: z.string().trim().max(60).nullable(),
}).strict();
export type PlanItemCopy = z.infer<typeof planItemCopySchema>;

export const editPlanItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  productId: z.string().min(1).optional(),
  photoIds: z.array(z.string().min(1)).min(1).max(REEL_MAX_PHOTOS).optional(),
  heroPhotoId: z.string().min(1).optional(),
  caption: z.string().trim().min(1).max(2200).optional(),
  hashtags: z.array(hashtagSchema).min(1).max(10).optional(), // Social Agent chain limit
  plannedAt: z.string().datetime().optional(),
}).strict();
export type EditPlanItemInput = z.infer<typeof editPlanItemSchema>;
