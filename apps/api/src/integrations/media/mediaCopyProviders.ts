import { HASHTAGS_PER_ITEM, planItemCopySchema, type PlanItemCopy } from "../../use-cases/media-planning/planner";

/**
 * Media Planning Agent copy providers. The AI writes captions/hashtags/hooks ONLY from ERP facts
 * supplied here - never maker, model, age, material, provenance, condition or capabilities that
 * are not in those facts. Uses the existing AI Intake OpenAI configuration (no new provider or
 * billing): AI_INTAKE_PROVIDER=openai + AI_INTAKE_OPENAI_API_KEY + AI_INTAKE_OPENAI_MODEL.
 */

export interface MediaCopyRequestItem {
  readonly key: string;
  readonly kind: "feed" | "reel";
  readonly product: { readonly sku: string; readonly title: string; readonly category: string | null; readonly brand: string | null; readonly condition: string | null };
  readonly photoCount: number;
  readonly plannedDate: string;
}
export interface MediaCopyProvider {
  readonly source: string;
  generate(items: readonly MediaCopyRequestItem[]): Promise<Record<string, PlanItemCopy>>;
}

export const BRAND_LINE = "Nova Vita ex Praeterito";
const slug = (value: string) => value.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase().slice(0, 40);

/** Fact-only templates: title, brand, category and condition exactly as stored. No age/material claims. */
export class DeterministicMediaCopyProvider implements MediaCopyProvider {
  readonly source = "deterministic";
  async generate(items: readonly MediaCopyRequestItem[]) {
    const out: Record<string, PlanItemCopy> = {};
    for (const item of items) {
      const p = item.product;
      const facts = [p.brand ? `Brand: ${p.brand}.` : null, p.category ? `Category: ${p.category}.` : null, p.condition ? `Condition as listed: ${p.condition}.` : null].filter(Boolean).join(" ");
      const tags = [...new Set(["#noctella", p.category ? `#${slug(p.category)}` : null, p.brand ? `#${slug(p.brand)}` : null, "#collectors", "#collectibles", "#curatedfinds", "#objectstories"].filter((t): t is string => !!t && t.length > 3))].slice(0, HASHTAGS_PER_ITEM);
      out[item.key] = planItemCopySchema.parse({
        caption: `${p.title}${facts ? `\n\n${facts}` : ""}\n\nFrom the Noctella collection.`,
        hashtags: tags,
        hook: item.kind === "reel" ? p.title.slice(0, 80) : null,
        rationale: item.kind === "reel" ? `Reel built from ${item.photoCount} real ERP photo(s) of ${p.sku}.` : `Feed post for ${p.sku}${p.category ? ` (${p.category})` : ""} using its stored hero photo.`,
        frameTexts: null,
        finalFrameText: item.kind === "reel" ? `Noctella - ${BRAND_LINE}` : null,
      });
    }
    return out;
  }
}

const SYSTEM_PROMPT =
  "You write Instagram copy for Noctella, a curated vintage/collector shop. Use ONLY the product facts given " +
  "(title, brand, category, condition). Never invent a maker, model, age, era, material, provenance, condition " +
  "detail or capability that is not in the facts. Calm, collector-focused tone; no sales-heavy language, no prices, " +
  `no urgency. Exactly ${HASHTAGS_PER_ITEM} relevant hashtags per item (#word, no spaces). Use the phrase "${BRAND_LINE}" ` +
  "at most once in the whole plan and only where it fits naturally (e.g. a Reel final frame). For Reels give a short " +
  "opening hook (<= 80 chars) and a final frame text (<= 60 chars); for feed posts hook/frameTexts/finalFrameText are null.";

const itemSchema = {
  type: "object", additionalProperties: false,
  required: ["key", "caption", "hashtags", "hook", "rationale", "frameTexts", "finalFrameText"],
  properties: {
    key: { type: "string" }, caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } },
    hook: { type: ["string", "null"] }, rationale: { type: "string" }, frameTexts: { type: ["array", "null"], items: { type: "string" } }, finalFrameText: { type: ["string", "null"] },
  },
} as const;

export class OpenAiMediaCopyProvider implements MediaCopyProvider {
  readonly source: string;
  constructor(private readonly config: { apiKey: string; model: string }, private readonly fetchImpl: typeof fetch = fetch) { this.source = `openai:${config.model}`; }

  async generate(items: readonly MediaCopyRequestItem[]) {
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          instructions: SYSTEM_PROMPT,
          input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ items }) }] }],
          text: { format: { type: "json_schema", name: "media_plan_copy", strict: true, schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: itemSchema } } } } },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Error("MEDIA_COPY_PROVIDER_UNAVAILABLE"); }
    if (!res.ok) throw new Error(`MEDIA_COPY_PROVIDER_HTTP_${res.status}`);
    const body: any = await res.json().catch(() => null);
    const text = body?.output?.flatMap((o: any) => (o?.type === "message" && Array.isArray(o.content) ? o.content : [])).find((c: any) => c?.type === "output_text")?.text;
    if (typeof text !== "string") throw new Error("MEDIA_COPY_PROVIDER_INVALID_RESPONSE");
    const parsed = JSON.parse(text);
    const out: Record<string, PlanItemCopy> = {};
    for (const item of items) {
      const raw = parsed?.items?.find((x: any) => x?.key === item.key);
      if (!raw) throw new Error("MEDIA_COPY_PROVIDER_MISSING_ITEM");
      const { key: _key, ...copy } = raw;
      out[item.key] = planItemCopySchema.parse(item.kind === "feed" ? { ...copy, hook: null, frameTexts: null, finalFrameText: null } : copy);
    }
    return out;
  }
}

/** Same server-side configuration as AI Intake; null when AI is not configured (deterministic copy is used). */
export function createConfiguredMediaCopyProvider(env: NodeJS.ProcessEnv = process.env): MediaCopyProvider | null {
  if (env.AI_INTAKE_PROVIDER?.trim().toLowerCase() !== "openai") return null;
  const apiKey = env.AI_INTAKE_OPENAI_API_KEY, model = env.AI_INTAKE_OPENAI_MODEL;
  return apiKey && model ? new OpenAiMediaCopyProvider({ apiKey, model }) : null;
}
