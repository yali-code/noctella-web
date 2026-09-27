import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableColumns } from "drizzle-orm";
import { ensureSchema, ensureSocialContentAiColumns } from "../src/db/migrate";
import * as sqlite from "../src/db/schema.sqlite";
import * as postgres from "../src/db/schema.postgres";
import { createSocialContentService } from "../src/services/socialContent";

const contentColumns = ["hashtags", "concept", "ai_provider", "ai_model", "ai_prompt_version", "ai_generated_at", "ai_request_id", "ai_source_product_id"];
const schemaSql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
const legacySocialSql = `
CREATE TABLE social_contents (
 id TEXT PRIMARY KEY NOT NULL, platform TEXT NOT NULL DEFAULT 'instagram', account_label TEXT NOT NULL DEFAULT 'vault',
 content_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', caption TEXT NOT NULL DEFAULT '',
 product_id TEXT REFERENCES products(id) ON DELETE SET NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE social_content_media (
 id TEXT PRIMARY KEY NOT NULL, content_id TEXT NOT NULL REFERENCES social_contents(id) ON DELETE CASCADE,
 photo_id TEXT REFERENCES product_photos(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL,
 UNIQUE(content_id, photo_id), UNIQUE(content_id, sort_order)
);`;

describe("Social Content AI additive migration", () => {
  it("creates nullable fields and the unique request index for fresh SQLite databases", () => {
    const db = new Database(":memory:");
    try {
      ensureSchema(db);
      const columns = db.prepare("PRAGMA table_info(social_contents)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
      for (const name of contentColumns) expect(columns.find((column) => column.name === name)).toMatchObject({ notnull: 0, dflt_value: null });
      expect(db.prepare("PRAGMA table_info(social_content_media)").all()).toContainEqual(expect.objectContaining({ name: "editorial_alt_text", notnull: 0 }));
      expect(db.prepare("PRAGMA index_list(social_contents)").all()).toContainEqual(expect.objectContaining({ name: "idx_social_contents_ai_request_unique", unique: 1 }));
    } finally { db.close(); }
  });
  it("upgrades existing ETAP 2 rows through actual startup, and reruns without losing data", async () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec(schemaSql.slice(0, schemaSql.indexOf("CREATE TABLE IF NOT EXISTS social_contents")));
      db.exec(legacySocialSql);
      db.exec("INSERT INTO social_contents(id,content_type,caption,status,version) VALUES ('legacy','post','Old caption','approved',7); INSERT INTO social_content_media(id,content_id,photo_id,sort_order) VALUES ('legacy-media','legacy',NULL,0)");
      ensureSchema(db); // Must not execute the new-column index before ALTERs.
      const rows = db.prepare("SELECT * FROM social_contents").all();
      const mediaRows = db.prepare("SELECT * FROM social_content_media").all();
      ensureSchema(db); ensureSocialContentAiColumns(db);
      expect(db.prepare("SELECT * FROM social_contents").all()).toEqual(rows);
      expect(db.prepare("SELECT * FROM social_content_media").all()).toEqual(mediaRows);
      const service = createSocialContentService(drizzle(db, { schema: sqlite }), "test-memory");
      expect(await service.get("legacy")).toMatchObject({ caption: "Old caption", status: "approved", version: 7, hashtags: null, concept: null, aiProvider: null, aiModel: null, aiPromptVersion: null, aiGeneratedAt: null, aiRequestId: null, aiSourceProductId: null, missingMediaCount: 1 });
      expect(db.prepare("SELECT editorial_alt_text FROM social_content_media").get()).toEqual({ editorial_alt_text: null });
    } finally { db.close(); }
  });
  it("keeps SQLite/PostgreSQL columns and nullability aligned", () => {
    for (const name of ["socialContents", "socialContentMedia"] as const) {
      const columns = (table: any) => Object.values(getTableColumns(table)).map((column) => ({ name: column.name, notNull: column.notNull })).sort((a, b) => a.name.localeCompare(b.name));
      expect(columns(sqlite[name])).toEqual(columns(postgres[name]));
    }
  });
  it("limits PostgreSQL migration to nullable additions and the unique index, without rewrites", () => {
    const sql = readFileSync(new URL("../src/db/postgres-migrations/0030_social_content_ai_generation.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((value) => value.trim()).filter(Boolean);
    expect(statements).toHaveLength(10);
    for (const column of contentColumns) expect(statements).toContain(`ALTER TABLE social_contents ADD COLUMN IF NOT EXISTS ${column} ${column === "ai_generated_at" ? "TIMESTAMPTZ" : "TEXT"}`);
    expect(statements).toContain("ALTER TABLE social_content_media ADD COLUMN IF NOT EXISTS editorial_alt_text TEXT");
    expect(statements).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_social_contents_ai_request_unique ON social_contents(ai_request_id)");
  });
});
