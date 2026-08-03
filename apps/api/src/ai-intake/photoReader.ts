import { readFile } from "node:fs/promises";
import path from "node:path";
import { aiIntakePhotoStagingRoot } from "../services/aiIntakePhotoStorage";
import { BadRequestError, NotFoundError } from "../services/errors";
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

  async read(referenceId: string): Promise<Buffer> {
    assertNonEmptyReferenceId(referenceId);

    const storageKey = await this.#resolver.resolve(referenceId);
    if (!storageKey) throw new NotFoundError("Staged photo not found");
    assertSafeStorageKey(storageKey);

    const rootResolved = path.resolve(this.#root);
    const resolved = path.resolve(this.#root, storageKey);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new BadRequestError("Invalid staged photo reference");
    }

    return readFile(resolved);
  }
}
