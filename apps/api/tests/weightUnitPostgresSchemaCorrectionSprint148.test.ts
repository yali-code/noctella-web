// @vitest-environment node
// Sprint 148: static, network/database-free proof of the weightUnit Postgres schema correction -
// no live Postgres instance is available in this suite (production runs DATABASE_DRIVER=sqlite,
// where weight_unit was already `text` - see db/schema.ts's sqlite-only barrel export), so this
// verifies file content directly: the Drizzle schema declaration now matches the application/
// shared "kg"|"lb" string contract, the new forward migration contains the exact data-preserving
// cast, and the original historical migration (0001) was left completely untouched (proving the
// correction is additive/forward-only, never a rewrite of an already-applied migration).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEIGHT_UNIT_VALUES } from "@noctella/shared";

const apiRoot = path.join(__dirname, "..", "src");

describe("Sprint 148: weightUnit Postgres schema correction", () => {
  it("schema.postgres.ts declares weightUnit as text, not numeric", () => {
    const content = readFileSync(path.join(apiRoot, "db", "schema.postgres.ts"), "utf-8");
    expect(content).toMatch(/weightUnit: text\("weight_unit"\)/);
    expect(content).not.toMatch(/weightUnit: numeric\("weight_unit"/);
  });

  it("the application enum contract is unchanged (kg|lb) - the correction only touches storage type, never the value domain", () => {
    expect(WEIGHT_UNIT_VALUES).toEqual(["kg", "lb"]);
  });

  it("a new forward migration (0017) performs the exact data-preserving cast", () => {
    const content = readFileSync(path.join(apiRoot, "db", "postgres-migrations", "0017_sprint148_weightunit_text_correction.sql"), "utf-8");
    expect(content).toMatch(/ALTER TABLE products ALTER COLUMN weight_unit TYPE text USING weight_unit::text;/);
  });

  it("never converts an existing value to NULL and never rewrites/invents destructive cleanup SQL", () => {
    const content = readFileSync(path.join(apiRoot, "db", "postgres-migrations", "0017_sprint148_weightunit_text_correction.sql"), "utf-8");
    expect(content).not.toMatch(/SET\s+weight_unit\s*=\s*NULL/i);
    expect(content).not.toMatch(/DELETE FROM products/i);
    expect(content).not.toMatch(/DROP TABLE/i);
  });

  it("the original historical migration (0001) was left byte-for-byte untouched - still declares the original numeric column", () => {
    const content = readFileSync(path.join(apiRoot, "db", "postgres-migrations", "0001_sprint24_foundation.sql"), "utf-8");
    expect(content).toMatch(/weight_unit numeric\(18,6\)/);
  });

  it("the new canonical proposal migration (0018) is additive-only and does not touch the products table", () => {
    const content = readFileSync(path.join(apiRoot, "db", "postgres-migrations", "0018_sprint148_canonical_product_ai_proposals.sql"), "utf-8");
    expect(content).toMatch(/CREATE TABLE IF NOT EXISTS canonical_product_ai_proposals/);
    expect(content).not.toMatch(/ALTER TABLE products/);
    expect(content).not.toMatch(/DROP TABLE/i);
  });
});
