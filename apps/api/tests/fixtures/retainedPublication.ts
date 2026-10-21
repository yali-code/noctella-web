import { expect } from "vitest";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";

/** Retention preserves evidence names, never aliases the worker inode into canonical publication. */
export async function expectRetainedPublication(root: string, operation: any, query: (s: SQL) => Promise<any[]>) {
  for (const artifact of ["main", "thumb"] as const) {
    const [copy] = await query(sql`SELECT staging_name, copy_ino FROM photo_publication_copies WHERE operation_id = ${operation.id} AND artifact = ${artifact}`);
    const canonical = path.join(root, "photos", operation[artifact + "_key"]);
    const anchor = path.join(root, ".product-photo-publication", operation.id, artifact, copy.staging_name);
    const privateFile = path.join(root, ".product-photo-operations", operation.id, String(operation.generation), artifact + ".webp");
    const [published, retained, sealed] = await Promise.all([canonical, anchor, privateFile].map((file) => lstat(file, { bigint: true })));
    expect([retained.dev, retained.ino]).toEqual([published.dev, published.ino]);
    expect(String(published.ino)).toBe(String(copy.copy_ino));
    expect(published.nlink).toBe(2n);
    expect(sealed.ino).not.toBe(published.ino);
    expect(await readFile(privateFile)).toEqual(await readFile(canonical));
  }
}
