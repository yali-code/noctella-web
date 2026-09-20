import crypto from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { customerAccounts, customerAuthProviders, customerProfiles, customerSecurityTokens, customerSessions } from "../db/schema";
import { hashPassword, verifyPassword } from "./passwordHashing";
import { BadRequestError, ConflictError, UnauthorizedError } from "./errors";

export const CUSTOMER_SESSION_MS = 14 * 24 * 60 * 60 * 1000;
export const VERIFY_TOKEN_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_MS = 60 * 60 * 1000;
export const normalizeCustomerEmail = (value: string) => value.trim().toLowerCase();
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const rawSecret = () => crypto.randomBytes(32).toString("base64url");
const hashSecret = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export interface CustomerEmailSender {
  sendVerification(email: string, link: string): Promise<void>;
  sendPasswordReset(email: string, link: string): Promise<void>;
}

function storefrontOrigin(): string {
  const value = process.env.STOREFRONT_APP_ORIGIN;
  if (!value || value.includes(",")) throw new Error("A single STOREFRONT_APP_ORIGIN is required for customer security links");
  const parsed = new URL(value);
  if ((process.env.NODE_ENV === "production" && parsed.protocol !== "https:") || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("Invalid STOREFRONT_APP_ORIGIN for customer security links");
  }
  return parsed.origin;
}

function validatePassword(value: string): void {
  if (value.length < 12 || value.length > 256) throw new BadRequestError("Password must contain 12 to 256 characters");
}

async function issueToken(db: DbClient, accountId: string, purpose: "verify" | "reset", ttl: number): Promise<string> {
  const token = rawSecret();
  const issuedAt = now();
  await db.update(customerSecurityTokens).set({ consumedAt: issuedAt }).where(and(eq(customerSecurityTokens.accountId, accountId), eq(customerSecurityTokens.purpose, purpose), isNull(customerSecurityTokens.consumedAt)));
  await db.insert(customerSecurityTokens).values({ id: newId(), accountId, purpose, tokenHash: hashSecret(token), createdAt: issuedAt, expiresAt: new Date(Date.now() + ttl).toISOString(), consumedAt: null });
  return token;
}

async function consumeToken(db: DbClient, raw: string, purpose: "verify" | "reset") {
  if (!raw || raw.length > 256) throw new BadRequestError("Invalid or expired link");
  const [token] = await db.select().from(customerSecurityTokens).where(and(eq(customerSecurityTokens.tokenHash, hashSecret(raw)), eq(customerSecurityTokens.purpose, purpose), isNull(customerSecurityTokens.consumedAt), gt(customerSecurityTokens.expiresAt, now()))).limit(1);
  if (!token) throw new BadRequestError("Invalid or expired link");
  const consumedAt = now();
  const claimed = await db.update(customerSecurityTokens).set({ consumedAt }).where(and(eq(customerSecurityTokens.id, token.id), isNull(customerSecurityTokens.consumedAt), gt(customerSecurityTokens.expiresAt, consumedAt))).returning({ id: customerSecurityTokens.id });
  if (claimed.length !== 1) throw new BadRequestError("Invalid or expired link");
  return token;
}

export async function registerCustomer(db: DbClient, sender: CustomerEmailSender, input: { email: string; password: string; name: string; termsAccepted: boolean }) {
  const email = normalizeCustomerEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new BadRequestError("Valid email required");
  if (!input.name?.trim() || input.name.length > 200 || !input.termsAccepted) throw new BadRequestError("Name and Terms acknowledgement required");
  validatePassword(input.password);
  const [existingAccount] = await db.select().from(customerAccounts).where(eq(customerAccounts.normalizedEmail, email)).limit(1);
  if (existingAccount) throw new ConflictError("An account with this email already exists");
  const matches = await db.select().from(customerProfiles).where(sql`lower(trim(${customerProfiles.email})) = ${email}`);
  if (matches.length > 1) throw new ConflictError("Customer identity requires manual review");
  if (matches[0] && matches[0].status !== "Active") throw new ConflictError("Customer identity requires manual review");
  const customerId = matches[0]?.id ?? newId();
  const createdAt = now();
  const passwordHash = await hashPassword(input.password);
  const accountId = newId();
  try {
    db.transaction((tx) => {
      if (!matches.length) tx.insert(customerProfiles).values({ id: customerId, email, name: input.name.trim(), source: "Storefront", status: "Active", createdAt, updatedAt: createdAt }).run();
      tx.insert(customerAccounts).values({ id: accountId, customerId, normalizedEmail: email, passwordHash, emailVerifiedAt: null, status: "active", createdAt, updatedAt: createdAt }).run();
    });
  } catch { throw new ConflictError("Account registration conflict; please retry or contact support"); }
  const token = await issueToken(db, accountId, "verify", VERIFY_TOKEN_MS);
  await sender.sendVerification(email, `${storefrontOrigin()}/account?mode=verify&token=${encodeURIComponent(token)}`);
  return { ok: true };
}

export async function resendVerification(db: DbClient, sender: CustomerEmailSender, emailInput: string): Promise<{ ok: true }> {
  const email = normalizeCustomerEmail(emailInput);
  const [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.normalizedEmail, email)).limit(1);
  if (account && !account.emailVerifiedAt && account.status === "active") {
    try {
      const token = await issueToken(db, account.id, "verify", VERIFY_TOKEN_MS);
      await sender.sendVerification(email, `${storefrontOrigin()}/account?mode=verify&token=${encodeURIComponent(token)}`);
    } catch { /* Preserve the same public response for existing and absent accounts. */ }
  }
  return { ok: true };
}

export async function verifyCustomerEmail(db: DbClient, raw: string): Promise<{ ok: true }> {
  const token = await consumeToken(db, raw, "verify");
  await db.update(customerAccounts).set({ emailVerifiedAt: now(), updatedAt: now() }).where(and(eq(customerAccounts.id, token.accountId), isNull(customerAccounts.emailVerifiedAt)));
  return { ok: true };
}

export interface CustomerSessionIdentity { accountId: string; customerId: string; email: string; name: string | null; sessionId: string }
export async function resolveCustomerSession(db: DbClient, raw: string | undefined | null): Promise<CustomerSessionIdentity | null> {
  if (!raw || raw.length > 256) return null;
  const [session] = await db.select().from(customerSessions).where(and(eq(customerSessions.tokenHash, hashSecret(raw)), isNull(customerSessions.revokedAt), gt(customerSessions.expiresAt, now()))).limit(1);
  if (!session) return null;
  const [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.id, session.accountId)).limit(1);
  if (!account || account.status !== "active" || !account.emailVerifiedAt) return null;
  const [customer] = await db.select().from(customerProfiles).where(eq(customerProfiles.id, account.customerId)).limit(1);
  if (!customer || customer.status !== "Active") return null;
  return { accountId: account.id, customerId: customer.id, email: account.normalizedEmail, name: customer.name, sessionId: session.id };
}

export async function openCustomerSession(db: DbClient, accountId: string) {
  const raw = rawSecret();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
  await db.insert(customerSessions).values({ id: newId(), accountId, tokenHash: hashSecret(raw), createdAt: now(), expiresAt: expiresAt.toISOString(), revokedAt: null });
  return { raw, expiresAt };
}

export async function loginCustomer(db: DbClient, emailInput: string, password: string) {
  const email = normalizeCustomerEmail(emailInput);
  if (!email || email.length > 254 || !password || password.length > 256) throw new UnauthorizedError("Invalid email or password");
  const [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.normalizedEmail, email)).limit(1);
  if (!account || account.status !== "active" || !account.emailVerifiedAt || !account.passwordHash || !(await verifyPassword(password, account.passwordHash))) throw new UnauthorizedError("Invalid email or password");
  const [customer] = await db.select({ status: customerProfiles.status }).from(customerProfiles).where(eq(customerProfiles.id, account.customerId)).limit(1);
  if (customer?.status !== "Active") throw new UnauthorizedError("Invalid email or password");
  return openCustomerSession(db, account.id);
}

export async function logoutCustomer(db: DbClient, raw: string | undefined | null): Promise<void> {
  if (!raw) return;
  await db.update(customerSessions).set({ revokedAt: now() }).where(eq(customerSessions.tokenHash, hashSecret(raw)));
}

export async function forgotCustomerPassword(db: DbClient, sender: CustomerEmailSender, emailInput: string): Promise<{ ok: true }> {
  const email = normalizeCustomerEmail(emailInput);
  const [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.normalizedEmail, email)).limit(1);
  if (account && account.status === "active" && account.emailVerifiedAt) {
    try {
      const token = await issueToken(db, account.id, "reset", RESET_TOKEN_MS);
      await sender.sendPasswordReset(email, `${storefrontOrigin()}/account?mode=reset&token=${encodeURIComponent(token)}`);
    } catch { /* Provider failures must not turn this endpoint into an account oracle. */ }
  }
  return { ok: true };
}

export async function resetCustomerPassword(db: DbClient, raw: string, password: string): Promise<{ ok: true }> {
  validatePassword(password);
  const newHash = await hashPassword(password);
  const token = await consumeToken(db, raw, "reset");
  await db.update(customerAccounts).set({ passwordHash: newHash, updatedAt: now() }).where(eq(customerAccounts.id, token.accountId));
  await db.update(customerSessions).set({ revokedAt: now() }).where(and(eq(customerSessions.accountId, token.accountId), isNull(customerSessions.revokedAt)));
  return { ok: true };
}

/** A provider subject is authoritative. An email may link only to an already-verified account. */
export async function linkVerifiedGoogleCustomer(db: DbClient, identity: { subject: string; email: string; emailVerified: boolean; name?: string }) {
  if (!identity.emailVerified || !identity.subject) throw new UnauthorizedError("Verified Google identity required");
  const email = normalizeCustomerEmail(identity.email);
  const [linked] = await db.select().from(customerAuthProviders).where(and(eq(customerAuthProviders.provider, "google"), eq(customerAuthProviders.subject, identity.subject))).limit(1);
  if (linked) {
    const [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.id, linked.accountId)).limit(1);
    if (!account || account.normalizedEmail !== email || !account.emailVerifiedAt || account.status !== "active") throw new ConflictError("Google identity conflict");
    const [customer] = await db.select({ status: customerProfiles.status }).from(customerProfiles).where(eq(customerProfiles.id, account.customerId)).limit(1);
    if (customer?.status !== "Active") throw new ConflictError("Google identity conflict");
    return openCustomerSession(db, account.id);
  }
  let [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.normalizedEmail, email)).limit(1);
  if (account && (!account.emailVerifiedAt || account.status !== "active")) throw new ConflictError("Account linking requires review");
  if (!account) {
    const matches = await db.select().from(customerProfiles).where(sql`lower(trim(${customerProfiles.email})) = ${email}`);
    if (matches.length > 1) throw new ConflictError("Customer identity requires manual review");
    if (matches[0] && matches[0].status !== "Active") throw new ConflictError("Customer identity requires manual review");
    const customerId = matches[0]?.id ?? newId();
    const createdAt = now();
    const accountId = newId();
    try {
      db.transaction((tx) => {
        if (!matches.length) tx.insert(customerProfiles).values({ id: customerId, email, name: identity.name?.trim() || null, source: "Storefront", status: "Active", createdAt, updatedAt: createdAt }).run();
        tx.insert(customerAccounts).values({ id: accountId, customerId, normalizedEmail: email, passwordHash: null, emailVerifiedAt: createdAt, status: "active", createdAt, updatedAt: createdAt }).run();
      });
    } catch { throw new ConflictError("Google account linking conflict"); }
    [account] = await db.select().from(customerAccounts).where(eq(customerAccounts.id, accountId)).limit(1);
  }
  const [owner] = await db.select({ status: customerProfiles.status }).from(customerProfiles).where(eq(customerProfiles.id, account.customerId)).limit(1);
  if (owner?.status !== "Active") throw new ConflictError("Account linking requires review");
  const [otherProvider] = await db.select().from(customerAuthProviders).where(and(eq(customerAuthProviders.accountId, account.id), eq(customerAuthProviders.provider, "google"))).limit(1);
  if (otherProvider) throw new ConflictError("Account is linked to another Google identity");
  await db.insert(customerAuthProviders).values({ id: newId(), accountId: account.id, provider: "google", subject: identity.subject, createdAt: now() });
  return openCustomerSession(db, account.id);
}
