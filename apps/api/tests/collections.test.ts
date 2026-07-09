import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../src/services/errors";
import { archiveCollection, createCollection, restoreCollection } from "../src/services/collections";
import { createTestDb } from "./testDb";

describe("collection service", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a collection with a derived slug", async () => {
    const collection = await createCollection(db, {
      name: "Gentleman Series",
      displayOrder: 0,
      isActive: true,
    });
    expect(collection.slug).toBe("gentleman-series");
  });

  it("rejects a duplicate collection slug", async () => {
    await createCollection(db, { name: "Vintage", slug: "vintage", displayOrder: 0, isActive: true });
    await expect(
      createCollection(db, {
        name: "Vintage Duplicate",
        slug: "vintage",
        displayOrder: 1,
        isActive: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("archives and restores a collection", async () => {
    const collection = await createCollection(db, {
      name: "Night Sky",
      displayOrder: 0,
      isActive: true,
    });

    const archived = await archiveCollection(db, collection.id);
    expect(archived.isActive).toBe(false);

    const restored = await restoreCollection(db, collection.id);
    expect(restored.isActive).toBe(true);
  });
});
