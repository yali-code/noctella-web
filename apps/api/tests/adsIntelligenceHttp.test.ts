// @vitest-environment node
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";

import { sql } from "drizzle-orm";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminRole } from "@noctella/shared";

/** ADS-007: authenticated analytics.view, read-only, no mutation route, no provider call. */
describe("ADS-007 Ads Intelligence HTTP contract", () => {
  const path = "/api/analytics/ads/intelligence/meta/120210000000000001";
  let app: import("express").Express;
  let db: any;
  let ownerCookie = "";
  let editorCookie = "";
  async function login(role: AdminRole) {
    const { createAdminUser } = await import("../src/services/adminAuth");
    await createAdminUser(db, { email: `${role}@example.com`, password: "Correct-Horse-9!", role });
    const res = await request(app).post("/api/auth/login").send({ email: `${role}@example.com`, password: "Correct-Horse-9!" });
    const cookie = res.headers["set-cookie"];
    return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0]!;
  }
  beforeAll(async () => {
    app = (await import("../src/app")).default as any;
    db = (await import("../src/db/client")).db;
    ownerCookie = await login(AdminRole.Owner);
    editorCookie = await login(AdminRole.ProductEditor);
  }, 60_000);

  it("requires a session and analytics.view, validates input and never writes", async () => {
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set("Cookie", editorCookie)).status).toBe(403);
    expect((await request(app).get("/api/analytics/ads/intelligence/meta/abc").set("Cookie", ownerCookie)).status).toBe(400);
    expect((await request(app).get("/api/analytics/ads/intelligence/instagram/120210000000000001").set("Cookie", ownerCookie)).status).toBe(400);
    const counts = () => db.all(sql`SELECT (SELECT count(*) FROM analytics_runs) AS r, (SELECT count(*) FROM analytics_metric_snapshots) AS s`);
    const before = counts();
    const res = await request(app).get(path).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ status: "NOT_COLLECTED", currency: "EUR", spendAuthorized: false, eligibleForAutomaticAction: false, marketplaceRoas: null, marketplaceAttributionVerified: false });
    expect(counts()).toEqual(before);
  });

  it("exposes no mutation route", async () => {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      expect((await request(app)[method](path).set("Cookie", ownerCookie).send({ budgetChangeEur: 100 })).status).toBe(404);
    }
  });
});
