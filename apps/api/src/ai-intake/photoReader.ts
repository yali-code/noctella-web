import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { aiIntakePhotoStagingRoot } from "../services/aiIntakePhotoStorage";
import { BadRequestError, NotFoundError } from "../services/errors";
import { readStagedPhotoForExposure } from "../services/aiIntakeStagedExposure";
import type { AiIntakePhotoReader, AiIntakePhotoStorageKeyResolver } from "./types";

function assertNonEmptyReferenceId(referenceId: string): void {
  if (!referenceId || typeof referenceId !== "string") {
    throw new BadRequestError("Invalid staged photo reference");
  }
}

/**
 * Sprint 92 exact-review correction: storage keys are internally generated
 * (`${randomUUID()}.webp`) and therefore never legitimately absolute or
 * traversal-shaped, but this check is preserved as defense-in-depth on the
 * RESOLVED value, exactly as required, rather than trusting the resolver.
 */
function assertSafeStorageKey(storageKey: string): void {
  if (!storageKey || path.isAbsolute(storageKey)) {
    throw new BadRequestError("Invalid staged photo reference");
  }
  const segments = storageKey.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BadRequestError("Invalid staged photo reference");
  }
}

/**
 * Sprint 92 exact-review correction: resolves the opaque referenceId (a
 * canonical AiIntakePhoto id) to real bytes by first asking the injected
 * AiIntakePhotoStorageKeyResolver for the Sprint 91 storage key, then
 * confining the read to the private staging root. The reader never receives
 * a storage key directly from the AI-facing contract - it only ever sees
 * the opaque id, and only this file (plus its resolver) ever knows a
 * storage key exists. Imports aiIntakePhotoStagingRoot read-only from
 * services/aiIntakePhotoStorage.ts (no modification to that Sprint 91 file)
 * and never exposes it publicly - the root is a true JS private field
 * (#root), not a TypeScript-only `private` property, so it is inaccessible
 * at runtime as well as at compile time. Thrown errors never include the
 * resolved path, only a generic message.
 *
 * Not called anywhere in the live /generate request path in this sprint
 * (the mock provider never invokes AiIntakePhotoReader.read) - built and
 * directly unit-tested so the capability is real and ready for whichever
 * future sprint adds a provider that actually needs bytes.
 */
export class LocalAiIntakePhotoReader implements AiIntakePhotoReader {
  #root: string;
  #resolver: AiIntakePhotoStorageKeyResolver;

  constructor(resolver: AiIntakePhotoStorageKeyResolver, root: string = aiIntakePhotoStagingRoot) {
    this.#resolver = resolver;
    this.#root = root;
  }

  /** Private source bytes for W4 finalization only - never for routes or AI providers (see LocalAiIntakePhotoPreviewReader). */
  async read(referenceId: string): Promise<Buffer> {
    return readFile((await resolveStagedPhotoFile(this.#resolver, this.#root, referenceId)).file);
  }
}

/**
 * #390 Stage 1: the AI-provider reader. Same intake-scoped resolution and containment as LocalAiIntakePhotoReader,
 * but bytes go through readStagedPhotoForExposure: legacy staged WebP is returned unchanged, an original-source
 * upload only as a metadata-free bounded preview, so raw EXIF/GPS/serial data never reaches a provider.
 */
export class LocalAiIntakePhotoPreviewReader implements AiIntakePhotoReader {
  #root: string;
  #resolver: AiIntakePhotoStorageKeyResolver;

  constructor(resolver: AiIntakePhotoStorageKeyResolver, root: string = aiIntakePhotoStagingRoot) {
    this.#resolver = resolver;
    this.#root = root;
  }

  async read(referenceId: string): Promise<Buffer> {
    const { file, storageKey } = await resolveStagedPhotoFile(this.#resolver, this.#root, referenceId);
    return readStagedPhotoForExposure(file, storageKey);
  }
}

/** Resolver-scoped, contained, lstat-verified regular file; symlinks and non-files are refused, a missing file is NotFound. */
async function resolveStagedPhotoFile(resolver: AiIntakePhotoStorageKeyResolver, root: string, referenceId: string) {
  assertNonEmptyReferenceId(referenceId);

  const storageKey = await resolver.resolve(referenceId);
  if (!storageKey) throw new NotFoundError("Staged photo not found");
  assertSafeStorageKey(storageKey);

  const rootResolved = path.resolve(root);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new BadRequestError("Invalid staged photo reference");
  }

  let info;
  try {
    info = await lstat(resolved);
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") throw new NotFoundError("Staged photo file not found");
    throw new Error("Staged AI intake photo could not be read");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new BadRequestError("Invalid staged photo reference");
  return { file: resolved, storageKey };
}
