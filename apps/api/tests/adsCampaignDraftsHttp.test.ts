// @vitest-environment node
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminRole } from "@noctella/shared";

/** ADS-008: draft preview is analytics.view, read-only and has no approve/launch/mutation route. */
describe("ADS-008 campaign draft preview HTTP contract", () => {
  const query = "provider=meta&requestedDailyEur=2&hardDailyLimitEur=5&hardTotalLimitEur=20";
  const path = "/api/analytics/ads/campaign-draft/NOC-000007";
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

  it("requires a session and analytics.view and validates provider and EUR budget input", async () => {
    expect((await request(app).get(`${path}?${query}`)).status).toBe(401);
    expect((await request(app).get(`${path}?${query}`).set("Cookie", editorCookie)).status).toBe(403);
    for (const bad of ["provider=tiktok&requestedDailyEur=2&hardDailyLimitEur=5&hardTotalLimitEur=20", "provider=meta&requestedDailyEur=2.001&hardDailyLimitEur=5&hardTotalLimitEur=20", `${query}&approved=true`]) {
      expect((await request(app).get(`${path}?${bad}`).set("Cookie", ownerCookie)).status).toBe(400);
    }
    expect((await request(app).get(`/api/analytics/ads/campaign-draft/bad%20id?${query}`).set("Cookie", ownerCookie)).status).toBe(400);
  });

  it("exposes no approval, launch or mutation route", async () => {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      expect((await request(app)[method](`${path}?${query}`).set("Cookie", ownerCookie).send({ approve: true })).status).toBe(404);
    }
  });
});
