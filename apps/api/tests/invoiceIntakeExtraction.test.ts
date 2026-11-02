import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invoiceIntakes } from "../src/db/schema.sqlite";
import { buildInvoiceExtractionJsonSchema, parseInvoiceExtraction, type InvoiceExtraction } from "../src/ai-intake/invoiceExtractionSchema";
import { createInvoiceExtractor, OpenAiInvoiceExtractor, type InvoiceExtractor } from "../src/ai-intake/openAiInvoiceExtractor";
import {
  ConflictError,
  InvoiceExtractionFailedError,
  InvoiceExtractionUnavailableError,
  InvoiceReviewChecksFailedError,
  NotFoundError,
} from "../src/services/errors";
import { LocalInvoiceFileStorage } from "../src/services/invoiceFileStorage";
import {
  addInvoiceIntakeFile,
  cancelInvoiceCostSet,
  cancelInvoiceIntake,
  createInvoiceCostSet,
  extractInvoiceIntake,
  getInvoiceCostSet,
  reviewInvoiceIntake,
} from "../src/services/invoiceIntakes";
import { checkInvoiceValues, effectiveInvoiceValues, runInvoiceChecks } from "../src/use-cases/invoice-intake/invoiceReview";
import { createTestDb } from "./testDb";

/** PHASE-2B: invoice AI extraction + admin review. The extractor is always mocked; no network call is ever made. */
const f = <T>(value: T | null, evidence: string | null = value === null ? null : String(value), confidence = 0.95) => ({ value, evidence, confidence });

/** Auctionet house invoice 227552: 945 + 64 + 189 = 1198 SEK; 945 x 20% = 189. */
function invoice227552(): InvoiceExtraction {
  return {
    invoiceType: f("auction" as const, "Buyer's premium (20.00% excl. VAT)"),
    supplierName: f("Växjö Auktionskammare"),
    supplierVatNumber: f("SE556923023701"),
    platform: f("Auctionet"),
    invoiceNumber: f("227552"),
    issueDate: f("2026-10-20", "Issued 2026-10-20"),
    dueDate: f("2026-10-30", "Due 2026-10-30"),
    paidDate: f("2026-10-21", "Paid 2026-10-21"),
    currency: f("SEK"),
    vatNote: f("No VAT charged, intra-community supply of services."),
    reverseCharge: f(true, "No VAT charged, intra-community supply of services."),
    total: f(1198, "1,198 SEK"),
    lots: [{ lotNumber: f("5332164"), title: f("KAMEROR, 8 st, analoga/digitala, 1900/2000-tal."), itemCountHint: f(8, "8 st"), amount: f(945, "945") }],
    fees: [
      { type: f("hammer_fee" as const, "Hammer fee"), label: f("Hammer fee"), amount: f(64, "64"), percent: f(null), lotNumber: f("5332164") },
      { type: f("buyer_premium" as const, "Buyer's premium"), label: f("Buyer's premium (20.00% excl. VAT)"), amount: f(189, "189"), percent: f(20, "20.00%"), lotNumber: f("5332164") },
    ],
  };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

const fakeExtractor = (result: () => Promise<unknown>): InvoiceExtractor => ({ modelName: "test-model", extract: vi.fn(result) as any });

describe("invoice extraction schema (PHASE-2B)", () => {
  it("accepts a valid output", () => {
    expect(parseInvoiceExtraction(invoice227552())).toEqual(invoice227552());
  });

  it("rejects malformed output, a missing evidence key and a wrong type", () => {
    expect(parseInvoiceExtraction(null)).toBeNull();
    expect(parseInvoiceExtraction({})).toBeNull();
    const noEvidence: any = invoice227552();
    delete noEvidence.total.evidence;
    expect(parseInvoiceExtraction(noEvidence)).toBeNull();
    const wrongType: any = invoice227552();
    wrongType.total.value = "1,198";
    expect(parseInvoiceExtraction(wrongType)).toBeNull();
    const badEnum: any = invoice227552();
    badEnum.invoiceType.value = "shipping";
    expect(parseInvoiceExtraction(badEnum)).toBeNull();
    const badDate: any = invoice227552();
    badDate.issueDate.value = "20/10/2026";
    expect(parseInvoiceExtraction(badDate)).toBeNull();
    const extraKey: any = { ...invoice227552(), note: "x" };
    expect(parseInvoiceExtraction(extraKey)).toBeNull();
    const badConfidence: any = invoice227552();
    badConfidence.currency.confidence = 1.5;
    expect(parseInvoiceExtraction(badConfidence)).toBeNull();
  });

  it("JSON Schema is strict: every object lists all properties as required with no extra properties", () => {
    const walk = (node: any) => {
      if (node?.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
        Object.values(node.properties).forEach(walk);
      }
      if (node?.type === "array") walk(node.items);
    };
    const schema = buildInvoiceExtractionJsonSchema();
    walk(schema);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["invoiceType", "lots", "fees", "total", "reverseCharge"]));
  });
});

describe("invoice checks (PHASE-2B)", () => {
  const failing = (checks: ReturnType<typeof runInvoiceChecks>) => checks.filter((c) => !c.ok).map((c) => c.code);

  it("the 227552 numbers pass every check", () => {
    const checks = runInvoiceChecks(invoice227552());
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.code === "PREMIUM_MISMATCH")).toMatchObject({ ok: true });
  });

  it("a total off by 1 is TOTAL_MISMATCH (exact, in cents)", () => {
    expect(failing(runInvoiceChecks(invoice227552(), { total: 1199 }))).toEqual(["TOTAL_MISMATCH"]);
    expect(failing(runInvoiceChecks(invoice227552(), { total: 1198.01 }))).toEqual(["TOTAL_MISMATCH"]);
    expect(failing(runInvoiceChecks(invoice227552(), { total: null }))).toEqual(["TOTAL_MISMATCH"]);
  });

  it("a wrong premium is PREMIUM_MISMATCH; 1 unit of rounding is tolerated", () => {
    const values = effectiveInvoiceValues(invoice227552());
    const withPremium = (amount: number, total: number) => checkInvoiceValues({ ...values, total, fees: [values.fees[0], { ...values.fees[1], amount }] });
    expect(failing(withPremium(190, 1199))).toEqual([]);
    expect(failing(withPremium(200, 1209))).toEqual(["PREMIUM_MISMATCH"]);
    // A premium without a lot number is checked against the sum of all lots.
    expect(failing(checkInvoiceValues({ ...values, fees: [values.fees[0], { ...values.fees[1], lotNumber: null }] }))).toEqual([]);
  });

  it("an auction without lots is NO_LOTS; a missing currency is CURRENCY_MISSING", () => {
    expect(failing(runInvoiceChecks(invoice227552(), { lots: [], fees: [], total: 0 }))).toEqual(["NO_LOTS"]);
    expect(failing(runInvoiceChecks(invoice227552(), { currency: null }))).toEqual(["CURRENCY_MISSING"]);
    // A transport invoice needs no lots.
    expect(failing(runInvoiceChecks(invoice227552(), { invoiceType: "transport", lots: [], fees: [{ type: "transport", label: "Home delivery: 5332164. KAMEROR", amount: 350, percent: null, lotNumber: "5332164" }], total: 350 }))).toEqual([]);
  });

  it("lists model values without evidence as UNSUPPORTED_FIELDS, but not admin-edited ones", () => {
    const extraction = invoice227552();
    extraction.platform.evidence = null;
    extraction.lots[0].title.evidence = null;
    const checks = runInvoiceChecks(extraction);
    expect(checks.find((c) => c.code === "UNSUPPORTED_FIELDS")).toMatchObject({ ok: false, fields: ["platform", "lots[0].title"] });
    expect(runInvoiceChecks(extraction, { platform: "Auctionet", lots: effectiveInvoiceValues(extraction).lots }).find((c) => c.code === "UNSUPPORTED_FIELDS")).toMatchObject({ ok: true });
  });
});

describe("invoice extraction and review use cases (PHASE-2B)", () => {
  let db: ReturnType<typeof createTestDb>;
  let dir: string;
  let storage: LocalInvoiceFileStorage;

  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(path.join(os.tmpdir(), "invoice-extract-"));
    storage = new LocalInvoiceFileStorage(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function uploaded(invoiceType = "auction", file = { buffer: PDF, mimetype: "application/pdf", originalname: "227552.pdf" }) {
    const set = await createInvoiceCostSet(db as any, { title: "227552" });
    const intake: any = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType, file }, storage);
    return { set, intake };
  }
  const extract = (id: string, extractor = fakeExtractor(async () => invoice227552())) => extractInvoiceIntake(db as any, id, { storage, createExtractor: () => extractor });
  const row = async (id: string) => (await db.select().from(invoiceIntakes)).find((r: any) => r.id === id) as any;

  it("extracts an uploaded intake: stores extraction + checks + model, refreshes summary columns, no file path in output", async () => {
    const { set, intake } = await uploaded();
    const extractor = fakeExtractor(async () => invoice227552());
    const result: any = await extract(intake.id, extractor);
    expect(extractor.extract).toHaveBeenCalledWith({ bytes: PDF, mime: "application/pdf" });
    expect(result).toMatchObject({
      status: "extracted", invoiceType: "auction", supplierVatNumber: "SE556923023701", platform: "Auctionet", invoiceNumber: "227552",
      issueDate: "2026-10-20", paidDate: "2026-10-21", currency: "SEK", totalOriginal: 1198, reverseCharge: true, lotNumbers: JSON.stringify(["5332164"]),
    });
    expect(result.review.effective.lots[0]).toEqual({ lotNumber: "5332164", title: "KAMEROR, 8 st, analoga/digitala, 1900/2000-tal.", itemCountHint: 8, amount: 945 });
    expect(result.review.extracted.total).toEqual({ value: 1198, evidence: "1,198 SEK", confidence: 0.95 });
    expect(result.review.checks.every((c: any) => c.ok)).toBe(true);
    expect(result.review.model).toBe("test-model");
    for (const out of [result, await getInvoiceCostSet(db as any, set.id)]) {
      const json = JSON.stringify(out);
      expect(json).not.toContain(dir);
      expect(json).not.toContain("fileRelativePath");
      expect(json).not.toContain("extractionJson");
      expect(json).not.toContain(`${set.id}/${intake.id}`);
    }
    const stored = JSON.parse((await row(intake.id)).extractionJson);
    expect(stored).toMatchObject({ model: "test-model", output: invoice227552() });
    expect(stored.checks).toHaveLength(5);
  });

  it("sends an image intake with its own MIME type", async () => {
    const { intake } = await uploaded("transport", { buffer: PNG, mimetype: "image/png", originalname: "t.png" });
    const extractor = fakeExtractor(async () => invoice227552());
    await extract(intake.id, extractor);
    expect(extractor.extract).toHaveBeenCalledWith({ bytes: PNG, mime: "image/png" });
  });

  it("extracts only on an open set and from uploaded/extracted", async () => {
    const { set, intake } = await uploaded();
    await expect(extract("missing")).rejects.toBeInstanceOf(NotFoundError);
    await extract(intake.id);
    await reviewInvoiceIntake(db as any, intake.id, { edits: {}, confirm: true });
    await expect(extract(intake.id)).rejects.toBeInstanceOf(ConflictError);

    const other = await uploaded();
    await cancelInvoiceIntake(db as any, other.intake.id);
    await expect(extract(other.intake.id)).rejects.toBeInstanceOf(ConflictError);

    const third: any = await addInvoiceIntakeFile(db as any, { costSetId: set.id, invoiceType: "transport", file: { buffer: PNG, mimetype: "image/png" } }, storage);
    await cancelInvoiceCostSet(db as any, set.id);
    const extractor = fakeExtractor(async () => invoice227552());
    await expect(extract(third.id, extractor)).rejects.toBeInstanceOf(ConflictError);
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("re-extract replaces the extraction and clears the edits", async () => {
    const { intake } = await uploaded();
    await extract(intake.id);
    await reviewInvoiceIntake(db as any, intake.id, { edits: { supplierName: "Edited" }, confirm: false });
    expect((await row(intake.id)).editsJson).not.toBeNull();
    const second = invoice227552();
    second.invoiceNumber = f("227553");
    const result: any = await extract(intake.id, fakeExtractor(async () => second));
    expect(result).toMatchObject({ status: "extracted", invoiceNumber: "227553", supplierName: "Växjö Auktionskammare" });
    expect(result.review.editedFields).toEqual([]);
    expect((await row(intake.id)).editsJson).toBeNull();
  });

  it("an extractor error or malformed output leaves the intake unchanged", async () => {
    const { intake } = await uploaded();
    const before = await row(intake.id);
    const leak = "SECRET-INVOICE-CONTENT sk-test-key";
    const thrown = await extract(intake.id, fakeExtractor(async () => { throw new Error(leak); })).catch((e) => e);
    expect(thrown).toBeInstanceOf(InvoiceExtractionFailedError);
    expect(thrown.message).not.toContain("SECRET");
    const malformed: any = invoice227552();
    delete malformed.lots;
    await expect(extract(intake.id, fakeExtractor(async () => malformed))).rejects.toBeInstanceOf(InvoiceExtractionFailedError);
    expect(await row(intake.id)).toEqual(before);
  });

  it("a provider other than openai fails closed before reading the file, and the intake is unchanged", async () => {
    const { intake } = await uploaded();
    const before = await row(intake.id);
    for (const env of [{ AI_INTAKE_PROVIDER: "mock" }, {}, { AI_INTAKE_PROVIDER: "openai", AI_INTAKE_OPENAI_MODEL: "m" }, { AI_INTAKE_PROVIDER: "openai", AI_INTAKE_OPENAI_API_KEY: "k" }]) {
      expect(() => createInvoiceExtractor(env as any)).toThrow(InvoiceExtractionUnavailableError);
    }
    expect(createInvoiceExtractor({ AI_INTAKE_PROVIDER: "openai", AI_INTAKE_OPENAI_API_KEY: "k", AI_INTAKE_OPENAI_MODEL: "m" } as any).modelName).toBe("m");
    const previous = process.env.AI_INTAKE_PROVIDER;
    process.env.AI_INTAKE_PROVIDER = "mock";
    try {
      await expect(extractInvoiceIntake(db as any, intake.id, { storage })).rejects.toBeInstanceOf(InvoiceExtractionUnavailableError);
    } finally {
      if (previous === undefined) delete process.env.AI_INTAKE_PROVIDER; else process.env.AI_INTAKE_PROVIDER = previous;
    }
    expect(await row(intake.id)).toEqual(before);
  });

  it("review changes invoiceType auction -> transport, stores and denormalizes it", async () => {
    const { set, intake } = await uploaded("auction");
    await extract(intake.id);
    const edits = {
      invoiceType: "transport" as const,
      lots: [],
      fees: [{ type: "transport" as const, label: "Home delivery: 5332164. KAMEROR", amount: 450, percent: null, lotNumber: "5332164" }],
      total: 450,
    };
    const result: any = await reviewInvoiceIntake(db as any, intake.id, { edits, confirm: true });
    expect(result).toMatchObject({ status: "reviewed", invoiceType: "transport", totalOriginal: 450, lotNumbers: JSON.stringify(["5332164"]) });
    expect(result.review.editedFields).toEqual(["invoiceType", "total", "lots", "fees"]);
    expect(JSON.parse((await row(intake.id)).editsJson)).toMatchObject({ edits, confirmed: true });
    const detail: any = await getInvoiceCostSet(db as any, set.id);
    expect(detail.intakes[0]).toMatchObject({ invoiceType: "transport", status: "reviewed" });
    expect(detail.intakes[0].review.effective.invoiceType).toBe("transport");
  });

  it("confirm is blocked by TOTAL_MISMATCH (409 with the checks, nothing stored); saving without confirm is allowed", async () => {
    const { intake } = await uploaded();
    await extract(intake.id);
    const before = await row(intake.id);
    const error = await reviewInvoiceIntake(db as any, intake.id, { edits: { total: 1199 }, confirm: true }).catch((e) => e);
    expect(error).toBeInstanceOf(InvoiceReviewChecksFailedError);
    expect(error.checks.find((c: any) => c.code === "TOTAL_MISMATCH")).toMatchObject({ ok: false });
    expect(await row(intake.id)).toEqual(before);

    const saved: any = await reviewInvoiceIntake(db as any, intake.id, { edits: { total: 1199 }, confirm: false });
    expect(saved).toMatchObject({ status: "extracted", totalOriginal: 1199 });
    // A non-blocking failure (UNSUPPORTED/PREMIUM etc.) does not block confirmation.
    const confirmed: any = await reviewInvoiceIntake(db as any, intake.id, { edits: { currency: null }, confirm: true });
    expect(confirmed.status).toBe("reviewed");
    expect(confirmed.review.checks.find((c: any) => c.code === "CURRENCY_MISSING").ok).toBe(false);
    // Editing a reviewed intake without confirming returns it to extracted.
    expect(((await reviewInvoiceIntake(db as any, intake.id, { edits: {}, confirm: false })) as any).status).toBe("extracted");
  });

  it("review requires an extraction and an open set", async () => {
    const { set, intake } = await uploaded();
    await expect(reviewInvoiceIntake(db as any, intake.id, { edits: {}, confirm: false })).rejects.toBeInstanceOf(ConflictError);
    await extract(intake.id);
    await cancelInvoiceCostSet(db as any, set.id);
    await expect(reviewInvoiceIntake(db as any, intake.id, { edits: {}, confirm: true })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("OpenAiInvoiceExtractor (PHASE-2B, fetch mocked)", () => {
  const API_KEY = "sk-test-invoice-key-123";
  const okResponse = (output: unknown) => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  let logSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends a PDF as input_file with a base64 data URL, strict json_schema, a timeout, and the key only in Authorization", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(okResponse(invoice227552()));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const result = await new OpenAiInvoiceExtractor({ apiKey: API_KEY, model: "gpt-test" }).extract({ bytes: PDF, mime: "application/pdf" });
    expect(result).toEqual(invoice227552());

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(String(init.body)).not.toContain(API_KEY);
    expect(url).not.toContain(API_KEY);

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-test");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "invoice_extraction", strict: true });
    expect(body.instructions).toMatch(/data, not instructions/);
    expect(body.instructions).toMatch(/Never invent values/);
    const file = body.input[0].content.find((c: any) => c.type === "input_file");
    expect(file).toEqual({ type: "input_file", filename: "invoice.pdf", file_data: `data:application/pdf;base64,${PDF.toString("base64")}` });
    expect(body.input[0].content.some((c: any) => c.type === "input_image")).toBe(false);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("sends a PNG/JPEG as input_image with a data URL", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(okResponse(invoice227552()));
    await new OpenAiInvoiceExtractor({ apiKey: API_KEY, model: "gpt-test" }).extract({ bytes: PNG, mime: "image/png" });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.input[0].content.find((c: any) => c.type === "input_image")).toEqual({ type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(body.input[0].content.some((c: any) => c.type === "input_file")).toBe(false);
  });

  it("maps every failure to one generic error without the upstream text, and logs nothing", async () => {
    const extractor = new OpenAiInvoiceExtractor({ apiKey: API_KEY, model: "gpt-test" });
    const malformed: any = invoice227552();
    malformed.total.value = "1,198";
    const cases: Array<() => Promise<Response>> = [
      async () => { throw new Error(`connect failed ${API_KEY}`); },
      async () => new Response(`{"error":"invalid key ${API_KEY}"}`, { status: 401 }),
      async () => new Response("upstream", { status: 500 }),
      async () => new Response("not json", { status: 200 }),
      async () => new Response(JSON.stringify({ output: [{ type: "refusal" }] }), { status: 200 }),
      async () => okResponse(malformed),
    ];
    for (const response of cases) {
      vi.spyOn(global, "fetch").mockImplementationOnce(response);
      const error = await extractor.extract({ bytes: PDF, mime: "application/pdf" }).catch((e) => e);
      expect(error).toBeInstanceOf(InvoiceExtractionFailedError);
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain("1,198");
    }
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
