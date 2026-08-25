import { describe, expect, it } from "vitest";
import { duplicateChecks, runMarketplaceDuplicatePreflight } from "../src/scripts/postgresMarketplaceDuplicatePreflight";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

describe("Sprint 151 marketplace duplicate preflight", () => {
  it("uses one read-only transaction and SELECT-only duplicate checks", async () => {
    const statements: string[] = [];
    const fake = { async query(sql: string) { statements.push(sql); return { rows: sql.includes("marketplace_orders") ? [{ channel:"ebay", duplicate_key:"secret-order", duplicate_count:2 }] : [] }; } };
    const findings = await runMarketplaceDuplicatePreflight(fake);
    expect(statements[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.slice(1,-1)).toHaveLength(4);
    expect(statements.slice(1,-1).every((sql) => /^SELECT /i.test(sql))).toBe(true);
    expect(statements.join(" ")).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|ALTER|DROP|TRUNCATE)\b/i);
    expect(findings).toEqual([{ table:"marketplace_orders", channel:"ebay", keyFingerprint:expect.stringMatching(/^[a-f0-9]{12}$/), duplicateCount:2 }]);
    expect(JSON.stringify(findings)).not.toContain("secret-order");
  });

  it("covers exactly the Sprint 149 and Sprint 150 uniqueness keys", () => {
    expect(duplicateChecks).toEqual([
      {table:"marketplace_connections",columns:["channel","account_label"]},
      {table:"external_listings",columns:["channel","external_listing_id"]},
      {table:"marketplace_webhook_events",columns:["channel","external_event_id"]},
      {table:"marketplace_orders",columns:["channel","external_order_id"]},
    ]);
  });

  it.skipIf(!postgresTestConfigured)("detects all four duplicate groups without changing rows on real PostgreSQL", async () => {
    const harness = await createPostgresTestDb("0019_sprint149_product_lifecycle.sql");
    try {
      const now = new Date();
      await harness.pool.query("INSERT INTO marketplace_connections(id,channel,account_label,status,created_at,updated_at) VALUES ('c1','ebay','same','connected',$1,$1),('c2','ebay','same','connected',$1,$1)",[now]);
      await harness.pool.query("INSERT INTO external_listings(id,product_id,channel,connection_id,external_listing_id,external_status,payload_snapshot,published_at,updated_at) VALUES ('l1','p','ebay','c1','same','active','{}',$1,$1),('l2','p','ebay','c1','same','active','{}',$1,$1)",[now]);
      await harness.pool.query("INSERT INTO marketplace_webhook_events(id,channel,external_event_id,event_type,status,signature_valid,payload_snapshot,attempt_count,received_at,created_at,updated_at) VALUES ('w1','ebay','same','order_paid','received',1,'{}',0,$1,$1,$1),('w2','ebay','same','order_paid','received',1,'{}',0,$1,$1,$1)",[now]);
      await harness.pool.query("INSERT INTO marketplace_orders(id,channel,external_order_id,marketplace_connection_id,status,import_status,retryable,currency,subtotal,shipping,tax,total,raw_payload_snapshot,ordered_at,imported_at,updated_at) VALUES ('o1','ebay','same','c1','pending','pending',1,'EUR',1,0,0,1,'{}',$1,$1,$1),('o2','ebay','same','c1','pending','pending',1,'EUR',1,0,0,1,'{}',$1,$1,$1)",[now]);
      const before = await harness.pool.query("SELECT (SELECT count(*) FROM marketplace_connections)+(SELECT count(*) FROM external_listings)+(SELECT count(*) FROM marketplace_webhook_events)+(SELECT count(*) FROM marketplace_orders) AS count");
      const client = await harness.pool.connect();
      try { expect(await runMarketplaceDuplicatePreflight(client)).toHaveLength(4); } finally { client.release(); }
      const after = await harness.pool.query("SELECT (SELECT count(*) FROM marketplace_connections)+(SELECT count(*) FROM external_listings)+(SELECT count(*) FROM marketplace_webhook_events)+(SELECT count(*) FROM marketplace_orders) AS count");
      expect(after.rows[0].count).toBe(before.rows[0].count);
    } finally { await harness.close(); }
  });
});
