// Shared Responses transport; callers retain their domain-specific error types.
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;
export async function requestStructuredResponse(apiKey: string, body: unknown, errors: {
  authentication: new () => Error; unavailable: new () => Error; invalid: new () => Error;
}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network-level failure (DNS, connection refused, timeout) - never the raw error (may embed
      // connection details), a fixed safe message only.
      throw new errors.unavailable();
    }

    if (res.status === 401 || res.status === 403) {
      throw new errors.authentication();
    }
    if (!res.ok) {
      // Covers rate limiting (429) and any provider-side 5xx - never the raw response body (may
      // include upstream error text), a fixed safe message only.
      throw new errors.unavailable();
    }

    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
    } catch {
      throw new errors.invalid();
    }

    const outputText = extractOutputText(parsedBody);
    if (outputText === null) throw new errors.invalid();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch {
      throw new errors.invalid();
    }

    return parsedJson;
}

function extractOutputText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.output)) return null;

  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (message.type !== "message") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const c = contentItem as Record<string, unknown>;
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }

  return null;
}
