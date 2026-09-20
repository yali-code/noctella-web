import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { createTestDb } from "./testDb";
import { adminSessions, customerAccounts, customerAuthProviders, customerOAuthAttempts, customerProfiles, customerSecurityTokens, customerSessions, orders } from "../src/db/schema";
import { createCustomerAccountRouter } from "../src/routes/customerAccount";
import { createCustomerAuthRouter } from "../src/routes/customerAuth";
import { createAdminUser, login as loginAdmin, validateSession as validateAdminSession } from "../src/services/adminAuth";
import { beginGoogleSignIn, finishGoogleSignIn, type CustomerGoogleProvider } from "../src/services/customerGoogle";
import { forgotCustomerPassword, linkVerifiedGoogleCustomer, loginCustomer, logoutCustomer, registerCustomer, resendVerification, resetCustomerPassword, resolveCustomerSession, verifyCustomerEmail, type CustomerEmailSender } from "../src/services/customerIdentity";

describe("Packet J Customer identity boundary", () => {
  let db: ReturnType<typeof createTestDb>;
  let messages: Array<{ kind: "verify" | "reset"; email: string; link: string }>;
  let sender: CustomerEmailSender;
  beforeEach(() => {
    db = createTestDb(); messages = [];
    sender = {
      sendVerification: async (email, link) => { messages.push({ kind: "verify", email, link }); },
      sendPasswordReset: async (email, link) => { messages.push({ kind: "reset", email, link }); },
    };
    process.env.STOREFRONT_APP_ORIGIN = "https://storefront.example.test";
  });
  afterEach(() => { delete process.env.STOREFRONT_APP_ORIGIN; vi.restoreAllMocks(); });
  const tokenFrom = (link: string) => new URL(link).searchParams.get("token")!;
  async function verified(email = "buyer@example.test") {
    await registerCustomer(db, sender, { email, password: "strong-pass-123", name: "Buyer Example", termsAccepted: true });
    await verifyCustomerEmail(db, tokenFrom(messages.at(-1)!.link));
  }

  it("registers with one canonical Customer, normalized email, hashed password and verification token", async () => {
    await registerCustomer(db, sender, { email: " BUYER@Example.Test ", password: "strong-pass-123", name: "Buyer Example", termsAccepted: true });
    const [account] = await db.select().from(customerAccounts);
    const customers = await db.select().from(customerProfiles);
    const [token] = await db.select().from(customerSecurityTokens);
    expect(customers).toHaveLength(1);
    expect(account.customerId).toBe(customers[0].id);
    expect(account.normalizedEmail).toBe("buyer@example.test");
    expect(account.passwordHash).not.toContain("strong-pass-123");
    expect(token.tokenHash).not.toBe(tokenFrom(messages[0].link));
    expect(messages[0].link).toMatch(/^https:\/\/storefront\.example\.test\/account\?mode=verify/);
    await expect(registerCustomer(db, sender, { email: "buyer@example.test", password: "strong-pass-123", name: "Other", termsAccepted: true })).rejects.toThrow();
    expect(await db.select().from(customerProfiles)).toHaveLength(1);
  });

  it("links one existing ERP Customer only after matching normalized email", async () => {
    await db.insert(customerProfiles).values({ id: "existing", email: "Buyer@Example.Test", name: "ERP Buyer", status: "Active", source: "ERP", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await registerCustomer(db, sender, { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true });
    const [account] = await db.select().from(customerAccounts);
    expect(account.customerId).toBe("existing");
    expect(await db.select().from(customerProfiles)).toHaveLength(1);
  });

  it("rejects invalid registration and ambiguous ERP Customer linkage", async () => {
    await expect(registerCustomer(db, sender, { email: "invalid", password: "strong-pass-123", name: "Buyer", termsAccepted: true })).rejects.toThrow();
    await expect(registerCustomer(db, sender, { email: "buyer@example.test", password: "short", name: "Buyer", termsAccepted: true })).rejects.toThrow();
    for (const id of ["a", "b"]) await db.insert(customerProfiles).values({ id, email: "buyer@example.test", name: id, status: "Active", source: "ERP", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await expect(registerCustomer(db, sender, { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true })).rejects.toThrow(/manual review/);
  });

  it("requires verification; rejects expired and replayed links; resend supersedes old link", async () => {
    await registerCustomer(db, sender, { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true });
    await expect(loginCustomer(db, "buyer@example.test", "strong-pass-123")).rejects.toThrow();
    const first = tokenFrom(messages[0].link);
    await resendVerification(db, sender, "buyer@example.test");
    const second = tokenFrom(messages[1].link);
    await expect(verifyCustomerEmail(db, first)).rejects.toThrow();
    await verifyCustomerEmail(db, second);
    await expect(verifyCustomerEmail(db, second)).rejects.toThrow();
    const session = await loginCustomer(db, "buyer@example.test", "strong-pass-123");
    expect(session.raw).toBeTruthy();
  });

  it("revokes Customer sessions on logout and reset without affecting Admin storage", async () => {
    await verified();
    await createAdminUser(db, { email: "operator@example.test", password: "admin-secret-123", role: "Admin" });
    const admin = await loginAdmin(db, { email: "operator@example.test", password: "admin-secret-123" });
    const first = await loginCustomer(db, "buyer@example.test", "strong-pass-123");
    expect(await resolveCustomerSession(db, admin.rawToken)).toBeNull();
    expect(await validateAdminSession(db, first.raw)).toBeNull();
    const second = await loginCustomer(db, "buyer@example.test", "strong-pass-123");
    expect(await resolveCustomerSession(db, first.raw)).toMatchObject({ email: "buyer@example.test" });
    await logoutCustomer(db, first.raw);
    expect(await resolveCustomerSession(db, first.raw)).toBeNull();
    await forgotCustomerPassword(db, sender, "buyer@example.test");
    await forgotCustomerPassword(db, sender, "unknown@example.test");
    expect(messages.filter((item) => item.kind === "reset")).toHaveLength(1);
    const reset = tokenFrom(messages.at(-1)!.link);
    await resetCustomerPassword(db, reset, "new-strong-pass-123");
    expect(await resolveCustomerSession(db, second.raw)).toBeNull();
    await expect(resetCustomerPassword(db, reset, "another-strong-pass-123")).rejects.toThrow();
    await expect(loginCustomer(db, "buyer@example.test", "strong-pass-123")).rejects.toThrow();
    expect((await loginCustomer(db, "buyer@example.test", "new-strong-pass-123")).raw).toBeTruthy();
    expect(await db.select().from(adminSessions)).toHaveLength(1);
    expect(await validateAdminSession(db, admin.rawToken)).toMatchObject({ email: "operator@example.test" });
  });

  it("Google state and nonce are single-use; fake provider never calls Google", async () => {
    const provider: CustomerGoogleProvider = {
      authorizationUrl: ({ state }) => `https://accounts.google.test/auth?state=${state}`,
      exchange: vi.fn(async () => ({ subject: "google-subject", email: "buyer@example.test", emailVerified: true, nonce: "wrong" })),
    };
    const started = await beginGoogleSignIn(db, provider);
    const state = new URL(started.url).searchParams.get("state")!;
    await expect(finishGoogleSignIn(db, provider, "wrong-state", "fake-code")).rejects.toThrow();
    await expect(finishGoogleSignIn(db, provider, state, "fake-code")).rejects.toThrow();
    await expect(finishGoogleSignIn(db, provider, state, "fake-code")).rejects.toThrow();
    expect(await db.select().from(customerOAuthAttempts)).toHaveLength(1);
    expect(await db.select().from(customerAccounts)).toHaveLength(0);
  });

  it("Google links only verified email and stable subject", async () => {
    await expect(linkVerifiedGoogleCustomer(db, { subject: "sub", email: "buyer@example.test", emailVerified: false })).rejects.toThrow();
    await verified();
    const linked = await linkVerifiedGoogleCustomer(db, { subject: "sub", email: "buyer@example.test", emailVerified: true });
    expect(linked.raw).toBeTruthy();
    expect(await db.select().from(customerAuthProviders)).toHaveLength(1);
    await linkVerifiedGoogleCustomer(db, { subject: "sub", email: "buyer@example.test", emailVerified: true });
    await expect(linkVerifiedGoogleCustomer(db, { subject: "other", email: "buyer@example.test", emailVerified: true })).rejects.toThrow();
    await expect(linkVerifiedGoogleCustomer(db, { subject: "sub", email: "other@example.test", emailVerified: true })).rejects.toThrow();
    expect(await db.select().from(customerProfiles)).toHaveLength(1);
  });

  it("fails closed on expired verification and session records", async () => {
    await registerCustomer(db, sender, { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true });
    await db.update(customerSecurityTokens).set({ expiresAt: "2000-01-01T00:00:00.000Z" });
    await expect(verifyCustomerEmail(db, tokenFrom(messages[0].link))).rejects.toThrow();
    await resendVerification(db, sender, "buyer@example.test");
    await verifyCustomerEmail(db, tokenFrom(messages[1].link));
    const session = await loginCustomer(db, "buyer@example.test", "strong-pass-123");
    await db.update(customerSessions).set({ expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await resolveCustomerSession(db, session.raw)).toBeNull();
  });

  it("invalidates Customer access when the canonical ERP Customer is inactive", async () => {
    await verified();
    const session = await loginCustomer(db, "buyer@example.test", "strong-pass-123");
    const [account] = await db.select().from(customerAccounts);
    await db.update(customerProfiles).set({ status: "Inactive" }).where(eq(customerProfiles.id, account.customerId));
    expect(await resolveCustomerSession(db, session.raw)).toBeNull();
    await expect(loginCustomer(db, "buyer@example.test", "strong-pass-123")).rejects.toThrow("Invalid email or password");
  });

  it("email failure leaves registration recoverable through resend", async () => {
    const broken: CustomerEmailSender = { sendVerification: async () => { throw new Error("mail outage"); }, sendPasswordReset: async () => { throw new Error("mail outage"); } };
    await expect(registerCustomer(db, broken, { email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true })).rejects.toThrow("mail outage");
    expect(await db.select().from(customerAccounts)).toHaveLength(1);
    await resendVerification(db, sender, "buyer@example.test");
    await verifyCustomerEmail(db, tokenFrom(messages[0].link));
    expect((await loginCustomer(db, "buyer@example.test", "strong-pass-123")).raw).toBeTruthy();
    expect(await forgotCustomerPassword(db, broken, "buyer@example.test")).toEqual({ ok: true });
    expect(await forgotCustomerPassword(db, broken, "absent@example.test")).toEqual({ ok: true });
  });

  it("completes a fake Google code flow with nonce and verified subject", async () => {
    let nonce = "";
    const provider: CustomerGoogleProvider = {
      authorizationUrl: (input) => { nonce = input.nonce; return `https://accounts.google.test/auth?state=${input.state}`; },
      exchange: vi.fn(async () => ({ subject: "subject-new", email: "google@example.test", emailVerified: true, name: "Google Buyer", nonce })),
    };
    const started = await beginGoogleSignIn(db, provider);
    const state = new URL(started.url).searchParams.get("state")!;
    const session = await finishGoogleSignIn(db, provider, state, "fake-code");
    expect((await resolveCustomerSession(db, session.raw))?.email).toBe("google@example.test");
    expect(await db.select().from(customerProfiles)).toHaveLength(1);
    expect(await db.select().from(customerAuthProviders)).toHaveLength(1);
  });

  it("Customer B cannot read, edit or delete A's addresses or orders", async () => {
    await verified("a@example.test");
    await verified("b@example.test");
    const a = await loginCustomer(db, "a@example.test", "strong-pass-123");
    const b = await loginCustomer(db, "b@example.test", "strong-pass-123");
    const aIdentity = await resolveCustomerSession(db, a.raw);
    const app = express(); app.use(express.json()); app.use("/account", createCustomerAccountRouter(db));
    const aCookie = `noctella_customer_session=${a.raw}`;
    const bCookie = `noctella_customer_session=${b.raw}`;
    const created = await request(app).post("/account/addresses").set("Cookie", aCookie).send({ type: "Shipping", fullName: "A Buyer", line1: "A Street", city: "City", postalCode: "10000", country: "Germany", countryCode: "DE" });
    expect(created.status).toBe(201);
    const addressId = created.body.id as string;
    const listed = await request(app).get("/account/addresses").set("Cookie", bCookie);
    expect(listed.status).toBe(200); expect(listed.body.items).toHaveLength(0);
    expect((await request(app).put(`/account/addresses/${addressId}`).set("Cookie", bCookie).send({ type: "Shipping", fullName: "B Buyer", line1: "B Street", city: "City", postalCode: "10000", country: "Germany", countryCode: "DE" })).status).toBe(404);
    expect((await request(app).delete(`/account/addresses/${addressId}`).set("Cookie", bCookie)).status).toBe(404);
    expect((await request(app).get("/account/addresses").set("Cookie", aCookie)).body.items).toHaveLength(1);
    await db.insert(orders).values({ id: "order-a", orderNumber: "A-1", orderDraftId: "draft-a", customerId: aIdentity!.customerId, guestEmail: "a@example.test", status: "pending" as never, paymentStatus: "pending" as never, paymentProvider: "CashOnDelivery" as never, paymentReference: "cod-a", currency: "EUR" as never, subtotalAmount: 10, totalAmount: 10, billingAddress: "{}", shippingAddress: "{}", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect((await request(app).get("/account/orders").set("Cookie", bCookie)).body.items).toHaveLength(0);
    expect((await request(app).get("/account/orders/order-a").set("Cookie", bCookie)).status).toBe(404);
  });

  it("Customer HTTP cookies are HttpOnly, isolated from Admin, and revocable", async () => {
    const app = express(); app.use(express.json()); app.use("/auth", createCustomerAuthRouter(db, sender, () => { throw new Error("Google outage"); }));
    const registration = await request(app).post("/auth/register").send({ email: "buyer@example.test", password: "strong-pass-123", name: "Buyer", termsAccepted: true });
    expect(registration.status).toBe(201);
    expect((await request(app).post("/auth/login").set("Origin", "https://attacker.example.test").send({ email: "buyer@example.test", password: "strong-pass-123" })).status).toBe(403);
    expect((await request(app).post("/auth/verify-email").send({ token: tokenFrom(messages[0].link) })).status).toBe(200);
    const unavailable = await request(app).get("/auth/google/start");
    expect(unavailable.status).toBe(302);
    expect(unavailable.headers.location).toBe("https://storefront.example.test/account?google=unavailable");
    const login = await request(app).post("/auth/login").send({ email: "buyer@example.test", password: "strong-pass-123" });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"][0] as string;
    expect(cookie).toContain("noctella_customer_session=");
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax");
    expect(login.body).not.toHaveProperty("rawToken");
    expect((await request(app).get("/auth/me").set("Cookie", "noctella_admin_session=fake")).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).post("/auth/logout").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});
