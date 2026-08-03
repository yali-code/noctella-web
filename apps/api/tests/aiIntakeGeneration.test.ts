import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { createIntake, cancelIntake } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { generateAiIntakeProposalUseCase } from "../src/use-cases/ai-intake-generation/useCases";
import { buildAiIntakeGenerationContext } from "../src/ai-intake/context";
import { AI_INTAKE_PROMPT_VERSION, DeterministicAiIntakePromptBuilder } from "../src/ai-intake/promptBuilder";
import { LocalAiIntakePhotoReader } from "../src/ai-intake/photoReader";
import { MockAiIntakeGenerationProvider } from "../src/ai-intake/mockProvider";
import type { AiIntakeGenerationProvider, AiIntakeGenerationRequest, AiIntakeGenerationResult } from "../src/ai-intake/types";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { products, productImages, productPhotos, stockMovements, publishJobs, externalListings, aiListingDrafts } from "../src/db/schema";
import { MockAiListingProvider } from "../src/ai/mockProvider";
import { createTestDb } from "./testDb";

function mockPhotoStorage(): AiIntakePhotoStorage {
  let counter = 0;
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      return { storageKey: `mock-key-${counter}.webp` };
    }),
    deleteIntakePhoto: vi.fn(async () => {}),
  };
}

describe("ai intake generation provider seam (Sprint 92)", () => {
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;

  beforeEach(async () => {
    db = createTestDb();
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  describe("context builder", () => {
    it("maps intake and photos correctly, using the canonical photo id as referenceId", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const intake = { id: intakeId } as any;
      const context = buildAiIntakeGenerationContext(intake, [photo as any]);

      expect(context.intakeId).toBe(intakeId);
      expect(context.photos).toHaveLength(1);
      expect(context.photos[0]).toEqual({ id: photo.id, originalFilename: "front.png", referenceId: photo.id });
    });

    it("referenceId equals the opaque photo id, not the storage key", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const context = buildAiIntakeGenerationContext({ id: intakeId } as any, [photo as any]);

      expect(context.photos[0].referenceId).toBe(photo.id);
      expect(context.photos[0].referenceId).not.toBe(photo.storageKey);
    });

    it("the generation context contains no storage key value anywhere", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const context = buildAiIntakeGenerationContext({ id: intakeId } as any, [photo as any]);

      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(photo.storageKey);
    });

    it("does not expose storageKey as a field name", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const context = buildAiIntakeGenerationContext({ id: intakeId } as any, [photo as any]);
      expect(Object.keys(context.photos[0]).sort()).toEqual(["id", "originalFilename", "referenceId"]);
    });

    it("context contains no storage-root or function-typed fields", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const context = buildAiIntakeGenerationContext({ id: intakeId } as any, [photo as any]);
      for (const value of Object.values(context.photos[0])) {
        expect(typeof value).not.toBe("function");
      }
      expect(Object.keys(context)).toEqual(["intakeId", "photos"]);
    });

    it("works with an empty photo list", () => {
      const context = buildAiIntakeGenerationContext({ id: intakeId } as any, []);
      expect(context).toEqual({ intakeId, photos: [] });
    });

    it("is deterministic - identical input produces deep-equal output", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-1", storage);
      const intake = { id: intakeId } as any;
      const first = buildAiIntakeGenerationContext(intake, [photo as any]);
      const second = buildAiIntakeGenerationContext(intake, [photo as any]);
      expect(first).toEqual(second);
    });
  });

  describe("prompt builder", () => {
    const builder = new DeterministicAiIntakePromptBuilder();

    it("produces a byte-identical prompt for an identical context", () => {
      const context = { intakeId, photos: [{ id: "p1", originalFilename: "a.png", referenceId: "key-1.webp" }] };
      const first = builder.build(context);
      const second = builder.build(context);
      expect(first).toEqual(second);
    });

    it("returns a version matching the exported constant", () => {
      const result = builder.build({ intakeId, photos: [] });
      expect(result.version).toBe(AI_INTAKE_PROMPT_VERSION);
    });

    it("returns non-empty systemPrompt and userPrompt", () => {
      const result = builder.build({ intakeId, photos: [] });
      expect(result.systemPrompt.length).toBeGreaterThan(0);
      expect(result.userPrompt.length).toBeGreaterThan(0);
    });

    it("contains no Product/Inventory/marketplace/publishing vocabulary", () => {
      const result = builder.build({
        intakeId,
        photos: [{ id: "p1", originalFilename: "front.png", referenceId: "key-1.webp" }],
      });
      const combined = `${result.systemPrompt}\n${result.userPrompt}`.toLowerCase();
      for (const forbidden of ["sku", "stock", "inventory", "publish", "marketplace", "ebay", "etsy", "woocommerce", "category", "collection"]) {
        expect(combined).not.toContain(forbidden);
      }
    });

    it("has no time or randomness dependence across repeated calls at different real timestamps", async () => {
      const context = { intakeId, photos: [] };
      const first = builder.build(context);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = builder.build(context);
      expect(first).toEqual(second);
    });
  });

  describe("LocalAiIntakePhotoReader (isolated temp directory, injected resolver)", () => {
    let tempDir: string;
    let reader: LocalAiIntakePhotoReader;
    let resolveMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-ai-intake-generation-"));
      resolveMock = vi.fn(async (photoId: string) => (photoId === "photo-1" ? "real-file.webp" : null));
      reader = new LocalAiIntakePhotoReader({ resolve: resolveMock }, tempDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("resolves an opaque photo id to a storage key internally, then reads bytes", async () => {
      await writeFile(path.join(tempDir, "real-file.webp"), Buffer.from("hello"));
      const bytes = await reader.read("photo-1");
      expect(bytes.toString()).toBe("hello");
      expect(resolveMock).toHaveBeenCalledWith("photo-1");
    });

    it("rejects a missing photo id safely (resolver returns null)", async () => {
      await expect(reader.read("does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects when the resolved storage key points to a missing file", async () => {
      // "photo-1" resolves to real-file.webp, but the file is never written.
      await expect(reader.read("photo-1")).rejects.toThrow();
    });

    it("rejects an absolute resolved storage key, even though it comes from the resolver, not the caller", async () => {
      const absoluteResolver = { resolve: vi.fn(async () => path.resolve(tempDir, "real-file.webp")) };
      const absoluteReader = new LocalAiIntakePhotoReader(absoluteResolver, tempDir);
      await expect(absoluteReader.read("photo-1")).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects a path-traversal resolved storage key, even though it comes from the resolver, not the caller", async () => {
      const traversalResolver = { resolve: vi.fn(async () => "../secret.webp") };
      const traversalReader = new LocalAiIntakePhotoReader(traversalResolver, tempDir);
      await expect(traversalReader.read("photo-1")).rejects.toBeInstanceOf(BadRequestError);
    });

    it("never exposes the staging root - the instance has no enumerable root-like property, and error messages omit the resolved path", async () => {
      expect(Object.keys(reader)).toEqual([]);
      expect(JSON.stringify(reader)).toBe("{}");
      const traversalResolver = { resolve: vi.fn(async () => "../secret.webp") };
      const traversalReader = new LocalAiIntakePhotoReader(traversalResolver, tempDir);
      try {
        await traversalReader.read("photo-1");
        expect.unreachable();
      } catch (err) {
        expect(String((err as Error).message)).not.toContain(tempDir);
      }
    });
  });

  describe("createIntakeScopedPhotoStorageKeyResolver", () => {
    it("resolves a photo id belonging to the given intake to its real storage key", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const { createIntakeScopedPhotoStorageKeyResolver } = await import("../src/services/aiIntakePhotoStorageKeyResolver");
      const resolver = createIntakeScopedPhotoStorageKeyResolver(db as any, intakeId);
      const storageKey = await resolver.resolve(photo.id);
      expect(storageKey).toBe(photo.storageKey);
    });

    it("returns null for a nonexistent photo id", async () => {
      const { createIntakeScopedPhotoStorageKeyResolver } = await import("../src/services/aiIntakePhotoStorageKeyResolver");
      const resolver = createIntakeScopedPhotoStorageKeyResolver(db as any, intakeId);
      expect(await resolver.resolve("does-not-exist")).toBeNull();
    });

    it("returns null (does not resolve) for a photo id belonging to a different intake - cross-intake resolution is not possible", async () => {
      const storage = mockPhotoStorage();
      const otherIntake = await createIntake(db as any, "admin-2");
      const otherPhoto = await uploadIntakePhoto(db as any, otherIntake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "theirs.png", "admin-2", storage);

      const { createIntakeScopedPhotoStorageKeyResolver } = await import("../src/services/aiIntakePhotoStorageKeyResolver");
      const resolverScopedToIntake = createIntakeScopedPhotoStorageKeyResolver(db as any, intakeId);
      expect(await resolverScopedToIntake.resolve(otherPhoto.id)).toBeNull();
    });
  });

  describe("MockAiIntakeGenerationProvider", () => {
    // referenceId values here are canonical photo ids (opaque, uuid-shaped) - deliberately NOT
    // storage-key-shaped (".webp"-suffixed), matching how the real context builder produces them.
    const buildRequest = (photoCount: number): AiIntakeGenerationRequest => {
      const context = {
        intakeId,
        photos: Array.from({ length: photoCount }, (_, i) => ({ id: `p${i}`, originalFilename: `photo-${i}.png`, referenceId: `photo-id-${i}` })),
      };
      const prompt = new DeterministicAiIntakePromptBuilder().build(context);
      const photoReader = { read: vi.fn(async () => Buffer.from("")) };
      return { context, prompt, photoReader };
    };

    it("never receives a storage key - the request contains no .webp-suffixed value anywhere", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const request = buildRequest(2);
      await provider.generate(request);
      const serialized = JSON.stringify(request.context);
      expect(serialized).not.toMatch(/\.webp/);
    });

    it("produces a deterministic result for identical input", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const request = buildRequest(2);
      const first = await provider.generate(request);
      const second = await provider.generate(request);
      expect(first).toEqual(second);
    });

    it("returns the grouped proposal + metadata shape", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const result = await provider.generate(buildRequest(1));
      expect(result).toHaveProperty("proposal");
      expect(result).toHaveProperty("metadata");
      expect(Object.keys(result).sort()).toEqual(["metadata", "proposal"]);
    });

    it("never calls photoReader.read()", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const request = buildRequest(2);
      await provider.generate(request);
      expect(request.photoReader.read).not.toHaveBeenCalled();
    });

    it("reports metadata.promptVersion from request.prompt.version, not a duplicate hardcoded source", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const request = buildRequest(0);
      (request.prompt as any).version = "custom-test-version";
      const result = await provider.generate(request);
      expect(result.metadata.promptVersion).toBe("custom-test-version");
    });

    it("reports a stable providerName", async () => {
      const provider = new MockAiIntakeGenerationProvider();
      const result = await provider.generate(buildRequest(0));
      expect(result.metadata.providerName).toBe("mock-intake-v1");
    });

    it("has no network/import dependency (module source has no fetch/http/https/axios reference)", async () => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(path.resolve(__dirname, "../src/ai-intake/mockProvider.ts"), "utf8");
      expect(src).not.toMatch(/\bfetch\(|require\(["']https?["']\)|from ["']https?["']|axios/i);
    });
  });

  describe("use case: generateAiIntakeProposalUseCase", () => {
    it("orchestrates context -> prompt -> provider and returns the provider's result unchanged", async () => {
      const provider: AiIntakeGenerationProvider = { generate: vi.fn(async (req) => ({ proposal: { suggestedTitle: "t" }, metadata: { providerName: "stub", promptVersion: req.prompt.version } })) };
      const stubReader = { read: vi.fn(async () => Buffer.from("")) };
      const result = await generateAiIntakeProposalUseCase(provider, { intake: { id: intakeId } as any, photos: [] }, stubReader);
      expect(result.proposal.suggestedTitle).toBe("t");
      expect(result.metadata.providerName).toBe("stub");
      expect(provider.generate).toHaveBeenCalledTimes(1);
    });
  });

  describe("service: generateIntakeProposal (Sprint 93: now durable)", () => {
    it("succeeds for an Open intake with staged photos", async () => {
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const result = await generateIntakeProposal(db as any, intakeId);
      expect(result.title.suggestion).toContain("1 photo");
      expect(result.providerName).toBe("mock-intake-v1");
      expect(result.promptVersion).toBe(AI_INTAKE_PROMPT_VERSION);
      expect(result.stale).toBe(false);
    });

    it("succeeds for an Open intake with zero staged photos", async () => {
      const result = await generateIntakeProposal(db as any, intakeId);
      expect(result.title.suggestion).toContain("no photos");
    });

    it("throws NotFoundError for a nonexistent intake", async () => {
      await expect(generateIntakeProposal(db as any, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws BadRequestError for a Cancelled intake", async () => {
      await cancelIntake(db as any, intakeId, "admin-1");
      await expect(generateIntakeProposal(db as any, intakeId)).rejects.toBeInstanceOf(BadRequestError);
    });

    it("accepts an injected provider", async () => {
      const stubProvider: AiIntakeGenerationProvider = {
        generate: vi.fn(async () => ({ proposal: { suggestedTitle: "custom" }, metadata: { providerName: "stub-provider", promptVersion: "x" } })),
      };
      const result = await generateIntakeProposal(db as any, intakeId, stubProvider);
      expect(result.title.suggestion).toBe("custom");
      expect(stubProvider.generate).toHaveBeenCalledTimes(1);
    });

    it("end-to-end: the provider never receives a storage key, only opaque photo ids", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      let capturedContext: any;
      const capturingProvider: AiIntakeGenerationProvider = {
        generate: vi.fn(async (req) => {
          capturedContext = req.context;
          return { proposal: {}, metadata: { providerName: "capturing", promptVersion: req.prompt.version } };
        }),
      };
      await generateIntakeProposal(db as any, intakeId, capturingProvider);
      expect(capturedContext.photos[0].referenceId).toBe(photo.id);
      expect(capturedContext.photos[0].referenceId).not.toBe(photo.storageKey);
      expect(JSON.stringify(capturedContext)).not.toContain(photo.storageKey);
    });

    it("propagates a provider failure through the existing error handling", async () => {
      const failingProvider: AiIntakeGenerationProvider = { generate: vi.fn(async () => { throw new Error("simulated provider failure"); }) };
      await expect(generateIntakeProposal(db as any, intakeId, failingProvider)).rejects.toThrow("simulated provider failure");
    });

    it("causes zero database writes", async () => {
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await generateIntakeProposal(db as any, intakeId);

      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(productPhotos)).toHaveLength(0);
      expect(await db.select().from(productImages)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
      expect(await db.select().from(publishJobs)).toHaveLength(0);
      expect(await db.select().from(externalListings)).toHaveLength(0);
      expect(await db.select().from(aiListingDrafts)).toHaveLength(0);
    });

    it("does not invoke the existing AI Draft mock provider", async () => {
      const spy = vi.spyOn(MockAiListingProvider.prototype, "generateListing");
      await generateIntakeProposal(db as any, intakeId);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("does not load real photo bytes during the live generate path", async () => {
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const readSpy = vi.spyOn(LocalAiIntakePhotoReader.prototype, "read");
      await generateIntakeProposal(db as any, intakeId);
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });
  });

  describe("independence from ai_listing_drafts and the existing AI provider tree", () => {
    it("no import from ai/provider.ts, ai/mockProvider.ts, or ai_listing_drafts anywhere in ai-intake/, the new service, or the new use case", async () => {
      const fs = await import("node:fs/promises");
      const root = path.resolve(__dirname, "..");
      const files = [
        "src/ai-intake/types.ts",
        "src/ai-intake/context.ts",
        "src/ai-intake/promptBuilder.ts",
        "src/ai-intake/photoReader.ts",
        "src/ai-intake/mockProvider.ts",
        "src/services/aiIntakeGeneration.ts",
        "src/use-cases/ai-intake-generation/useCases.ts",
      ];
      for (const file of files) {
        const source = await fs.readFile(path.join(root, file), "utf8");
        const importLines = source.split("\n").filter((line) => /^\s*import /.test(line)).join("\n");
        expect(importLines).not.toMatch(/from ["']\.\.\/ai\/provider["']|from ["']\.\.\/ai\/mockProvider["']|aiListingDrafts|AiDraftStatus|ai-draft\//);
      }
    });
  });
});
