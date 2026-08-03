// Sprint 89: proves the POST /api/ai-drafts/:id/approve route's authenticated-reviewer-identity
// boundary end-to-end - the reviewer ID persisted on approval is always req.adminUser.id, never a
// client-supplied body value, and the existing ai_drafts.review permission remains required.
// Follows the exact supertest/real-app pattern established by authorizationHardeningSprint64C.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole, AiDraftStatus, ProductStatus, ProductType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { generateDraft } from "../src/services/aiDrafts";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-draft-approval-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-draft-approval";

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];
let categoryId: string;

const PASSWORD = "correct-password-123";
let reviewerCookie: string;
let noPermissionCookie: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

async function newPendingReviewDraftId(): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await createProduct(db, {
    sku: `SKU-APPROVE-${unique}`,
    title: `Route Test Product ${unique}`,
    type: ProductType.UniqueItem,
    status: ProductStatus.Draft,
    categoryId,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 300,
  });
  const draft = await generateDraft(db, product.id);
  return draft.id;
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;

  await createAdminUser(db, { email: "reviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  reviewerCookie = await login("reviewer@example.com");
  await createAdminUser(db, { email: "supportagent@example.com", password: PASSWORD, role: AdminRole.SupportAgent });
  noPermissionCookie = await login("supportagent@example.com");

  const category = await createCategory(db, { name: "AI Draft Approval Route", displayOrder: 0, isActive: true });
  categoryId = category.id;
});

describe("POST /api/ai-drafts/:id/approve — Sprint 89 authenticated reviewer identity", () => {
  it("accepts an empty body for an authenticated reviewer and persists req.adminUser.id, not a body value", async () => {
    const draftId = await newPendingReviewDraftId();
    const res = await request(app).post(`/api/ai-drafts/${draftId}/approve`).set("Cookie", reviewerCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(AiDraftStatus.Approved);

    // The persisted reviewedByAdminUserId must be a real admin user id, not "client-supplied-id".
    expect(res.body.reviewedByAdminUserId).toBeTruthy();
    expect(res.body.reviewedByAdminUserId).not.toBe("client-supplied-id");
  });

  it("rejects a client-supplied reviewedByAdminUserId in the request body", async () => {
    const draftId = await newPendingReviewDraftId();
    const res = await request(app)
      .post(`/api/ai-drafts/${draftId}/approve`)
      .set("Cookie", reviewerCookie)
      .send({ reviewedByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown request body field", async () => {
    const draftId = await newPendingReviewDraftId();
    const res = await request(app)
      .post(`/api/ai-drafts/${draftId}/approve`)
      .set("Cookie", reviewerCookie)
      .send({ somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("still requires the existing ai_drafts.review permission", async () => {
    const draftId = await newPendingReviewDraftId();
    const res = await request(app).post(`/api/ai-drafts/${draftId}/approve`).set("Cookie", noPermissionCookie).send({});
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const draftId = await newPendingReviewDraftId();
    const res = await request(app).post(`/api/ai-drafts/${draftId}/approve`).send({});
    expect(res.status).toBe(401);
  });
});
