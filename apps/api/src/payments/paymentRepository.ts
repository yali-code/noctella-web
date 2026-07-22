import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { PaymentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { payments } from "../db/schema";
import { BadRequestError, NotFoundError } from "../services/errors";
import { cancelMockPayment, initializeMockPayment, verifyMockPayment } from "./paymentService";

export interface PaymentSessionRecord {
  id: string;
  orderId: string | null;
  provider: string;
  providerReference: string;
  status: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  safeMetadata: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaymentSessionInput {
  provider: string;
  providerReference: string;
  status: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  safeMetadata?: unknown;
}

function toRecord(row: typeof payments.$inferSelect): PaymentSessionRecord {
  return {
    id: row.id,
    orderId: row.orderId ?? null,
    provider: row.provider,
    providerReference: row.providerReference ?? "",
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    idempotencyKey: row.idempotencyKey,
    safeMetadata: row.safeMetadata ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function derivePaymentIdempotencyKey(provider: string, orderDraftId: string): string {
  return `payment:${provider}:${orderDraftId}`;
}

export async function findPaymentByIdempotencyKey(
  db: DbClient,
  idempotencyKey: string,
): Promise<PaymentSessionRecord | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.idempotencyKey, idempotencyKey));
  return row ? toRecord(row) : undefined;
}

export async function findPaymentByProviderReference(
  db: DbClient,
  provider: string,
  providerReference: string,
): Promise<PaymentSessionRecord | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, provider), eq(payments.providerReference, providerReference)));
  return row ? toRecord(row) : undefined;
}

export async function createPaymentSession(
  db: DbClient,
  input: CreatePaymentSessionInput,
): Promise<PaymentSessionRecord> {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    orderId: null,
    provider: input.provider,
    providerReference: input.providerReference,
    status: input.status,
    amount: input.amount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    safeMetadata: input.safeMetadata !== undefined ? JSON.stringify(input.safeMetadata) : null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(payments).values(row);
  return toRecord(row as unknown as typeof payments.$inferSelect);
}

export interface ListPaymentsFilters {
  status?: string;
  provider?: string;
}

/** Read-only listing for the admin panel; reuses the same payments table and record shape as the rest of this file. */
export async function listPayments(db: DbClient, filters: ListPaymentsFilters = {}): Promise<PaymentSessionRecord[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(payments.status, filters.status));
  if (filters.provider) conditions.push(eq(payments.provider, filters.provider));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db.select().from(payments).where(where).orderBy(desc(payments.createdAt));
  return rows.map(toRecord);
}

/**
 * Links a payment session to its resulting Order. Persistence only — no
 * business-rule decisions, no status mutation, no Order/Inventory writes.
 * Safe to call repeatedly with the same pair (idempotent no-op on repeat).
 */
export async function linkPaymentToOrder(db: DbClient, paymentSessionId: string, orderId: string): Promise<void> {
  await db.update(payments).set({ orderId }).where(eq(payments.id, paymentSessionId));
}

export async function updatePaymentStatus(db: DbClient, id: string, status: string): Promise<PaymentSessionRecord> {
  const updatedAt = new Date().toISOString();
  await db.update(payments).set({ status, updatedAt }).where(eq(payments.id, id));
  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  return toRecord(row);
}

const VERIFY_ALLOWED_STATUSES: string[] = [PaymentStatus.Pending, PaymentStatus.Processing, PaymentStatus.Failed];
const CANCEL_ALLOWED_STATUSES: string[] = [PaymentStatus.Pending, PaymentStatus.Processing];

export interface PaymentSessionResult {
  provider: string;
  providerReference: string;
  status: string;
}

function toResult(session: PaymentSessionRecord): PaymentSessionResult {
  return { provider: session.provider, providerReference: session.providerReference, status: session.status };
}

/**
 * Persists a payment session around the existing mock provider call.
 * Idempotent per provider + orderDraftId: a repeat call returns the
 * already-persisted session and never inserts a second row.
 */
export async function initializePaymentSession(
  db: DbClient,
  input: { provider: string; orderDraftId: string; amount: number; currency: string },
): Promise<PaymentSessionResult> {
  const idempotencyKey = derivePaymentIdempotencyKey(input.provider, input.orderDraftId);
  const existing = await findPaymentByIdempotencyKey(db, idempotencyKey);
  if (existing) return toResult(existing);

  const result = await initializeMockPayment(input.provider, input);
  const session = await createPaymentSession(db, {
    provider: input.provider,
    providerReference: result.providerReference,
    status: result.status,
    amount: input.amount,
    currency: input.currency,
    idempotencyKey,
  });
  return toResult(session);
}

/** Finds the persisted session by provider + providerReference before calling the mock provider; unknown references are rejected without ever calling it. */
export async function verifyPaymentSession(
  db: DbClient,
  input: { provider: string; providerReference: string },
): Promise<PaymentSessionResult> {
  const session = await findPaymentByProviderReference(db, input.provider, input.providerReference);
  if (!session) throw new NotFoundError("Payment session not found");
  if (!VERIFY_ALLOWED_STATUSES.includes(session.status)) {
    throw new BadRequestError("Invalid payment status transition");
  }
  const result = await verifyMockPayment(input.provider, input);
  const updated = await updatePaymentStatus(db, session.id, result.status);
  return toResult(updated);
}

export async function cancelPaymentSession(
  db: DbClient,
  input: { provider: string; providerReference: string },
): Promise<PaymentSessionResult> {
  const session = await findPaymentByProviderReference(db, input.provider, input.providerReference);
  if (!session) throw new NotFoundError("Payment session not found");
  if (!CANCEL_ALLOWED_STATUSES.includes(session.status)) {
    throw new BadRequestError("Invalid payment status transition");
  }
  const result = await cancelMockPayment(input.provider, input);
  const updated = await updatePaymentStatus(db, session.id, result.status);
  return toResult(updated);
}
