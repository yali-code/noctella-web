import { and, asc, eq, isNull } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { TransactionPaymentEventRepository, TransactionPaymentEventRecord, TransactionPaymentRecord, TransactionPaymentRepository } from "./types";

type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
const then = <T, U>(value: Result<T>, next: (item: T) => Result<U>): Result<U> => value instanceof Promise ? value.then(next) : next(value);
const rows = (query: any, execution: Execution): Result<any[]> => execution === "synchronous" ? (Array.isArray(query) ? query : query.all()) : Promise.resolve(query).then((value: any) => Array.isArray(value) ? value : value.all());
const execute = (query: any, execution: Execution): Result<any> => execution === "synchronous" ? query.run() : Promise.resolve(query);
const affected = (result: any) => Number(result?.changes ?? result?.rowCount ?? 0);
const requireOne = (result: any, code: string) => { if (affected(result) !== 1) throw new Error(code); };

const payment = (row: any): TransactionPaymentRecord => ({ id: row.id, orderId: row.orderId ?? null, provider: row.provider, providerReference: row.providerReference ?? null, providerTransactionReference: row.providerTransactionReference ?? null, status: row.status, amount: Number(row.amount), expectedAmountCents: row.expectedAmountCents == null ? null : Number(row.expectedAmountCents), currency: row.currency, idempotencyKey: row.idempotencyKey, checkoutSnapshot: typeof row.checkoutSnapshot === "string" ? row.checkoutSnapshot : row.checkoutSnapshot == null ? null : JSON.stringify(row.checkoutSnapshot), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) });
const event = (row: any): TransactionPaymentEventRecord => ({ id: row.id, provider: row.provider, providerEventId: row.providerEventId, eventType: row.eventType, paymentId: row.paymentId ?? null, status: row.status, resultClassification: row.resultClassification ?? null, errorCode: row.errorCode ?? null, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) });

export function createTransactionPaymentRepositories(db: any, driver: "sqlite" | "postgres") {
  const schema: any = driver === "sqlite" ? sqliteSchema : postgresSchema;
  const execution: Execution = driver === "sqlite" ? "synchronous" : "asynchronous";
  const { payments, paymentEvents } = schema;
  const first = (query: any) => then(rows(query, execution), result => result[0] ?? null);
  const findPayment = (id: string) => then(first(db.select().from(payments).where(eq(payments.id, id)).limit(1)), row => row ? payment(row) : null);
  const findEvent = (provider: string, eventId: string) => then(first(db.select().from(paymentEvents).where(and(eq(paymentEvents.provider, provider), eq(paymentEvents.providerEventId, eventId))).limit(1)), row => row ? event(row) : null);

  const paymentRepository: TransactionPaymentRepository = {
    findById: findPayment,
    findByProviderReference: (provider, reference) => then(first(db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.providerReference, reference))).limit(1)), row => row ? payment(row) : null),
    findByIdempotencyKey: key => then(first(db.select().from(payments).where(eq(payments.idempotencyKey, key)).limit(1)), row => row ? payment(row) : null),
    createPendingCheckout: input => then(execute(db.insert(payments).values({ ...input, checkoutSnapshot: driver === "postgres" ? JSON.parse(input.checkoutSnapshot!) : input.checkoutSnapshot }), execution), () => input),
    setProviderReference: (id, reference) => then(findPayment(id), current => {
      if (!current || current.provider !== "stripe") throw new Error("PAYMENT_SESSION_UPDATE_REJECTED");
      if (current.providerReference === reference) return;
      if (current.providerReference !== null || current.status !== "pending" || current.orderId !== null) throw new Error("PAYMENT_SESSION_IDENTITY_CONFLICT");
      return then(execute(db.update(payments).set({ providerReference: reference }).where(and(eq(payments.id, id), eq(payments.provider, "stripe"), eq(payments.status, "pending"), isNull(payments.orderId), isNull(payments.providerReference))), execution), result => requireOne(result, "PAYMENT_SESSION_UPDATE_REJECTED"));
    }),
    markPaidAndLinkOrder: (id, orderId, transactionReference, updatedAt) => then(findPayment(id), current => {
      if (!current || current.provider !== "stripe") throw new Error("PAYMENT_PAID_UPDATE_REJECTED");
      if (current.status === "paid" && current.orderId === orderId && current.providerTransactionReference === transactionReference) return;
      if (current.status !== "pending" || current.orderId !== null || (current.providerTransactionReference !== null && current.providerTransactionReference !== transactionReference)) throw new Error("PAYMENT_PAID_IDENTITY_CONFLICT");
      return then(execute(db.update(payments).set({ orderId, providerTransactionReference: transactionReference, status: "paid", updatedAt }).where(and(eq(payments.id, id), eq(payments.provider, "stripe"), eq(payments.status, "pending"), isNull(payments.orderId))), execution), result => requireOne(result, "PAYMENT_PAID_UPDATE_REJECTED"));
    }),
    markManualRefundRequired: (id, transactionReference, updatedAt) => then(findPayment(id), current => {
      if (!current || current.provider !== "stripe") throw new Error("PAYMENT_MANUAL_REFUND_UPDATE_REJECTED");
      if (current.status === "manual_refund_required" && (current.providerTransactionReference === transactionReference || transactionReference === null)) return;
      if (current.status !== "pending" || current.orderId !== null || (current.providerTransactionReference !== null && current.providerTransactionReference !== transactionReference)) throw new Error("PAYMENT_MANUAL_REFUND_IDENTITY_CONFLICT");
      return then(execute(db.update(payments).set({ providerTransactionReference: transactionReference, status: "manual_refund_required", updatedAt }).where(and(eq(payments.id, id), eq(payments.provider, "stripe"), eq(payments.status, "pending"), isNull(payments.orderId))), execution), result => requireOne(result, "PAYMENT_MANUAL_REFUND_UPDATE_REJECTED"));
    }),
  };

  const eventRepository: TransactionPaymentEventRepository = {
    find: findEvent,
    listByPaymentId: paymentId => then(rows(db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId)).orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id)), execution), result => result.map(event)),
    claim: input => then(execute(db.insert(paymentEvents).values(input), execution), () => undefined),
    complete: (provider, eventId, paymentId, status, resultClassification, errorCode, updatedAt) => then(findEvent(provider, eventId), current => {
      if (!current) throw new Error("PAYMENT_EVENT_COMPLETION_REJECTED");
      if (current.status === status && current.paymentId === paymentId && current.resultClassification === resultClassification && current.errorCode === errorCode) return;
      if (current.status !== "processing" || (current.paymentId !== null && current.paymentId !== paymentId)) throw new Error("PAYMENT_EVENT_STATE_CONFLICT");
      return then(execute(db.update(paymentEvents).set({ paymentId, status, resultClassification, errorCode, updatedAt }).where(and(eq(paymentEvents.provider, provider), eq(paymentEvents.providerEventId, eventId), eq(paymentEvents.status, "processing"))), execution), result => requireOne(result, "PAYMENT_EVENT_COMPLETION_REJECTED"));
    }),
  };

  return { payments: paymentRepository, paymentEvents: eventRepository };
}
