"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getPaymentOperationsDetail, type PaymentOperationsDetail } from "@/lib/payments";

export default function PaymentDetailPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<PaymentOperationsDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getPaymentOperationsDetail(params.id).then(setDetail).catch((value) => setError(value instanceof Error ? value.message : "Failed to load payment")); }, [params.id]);
  if (error) return <main><h1>Payment</h1><p role="alert">{error}</p></main>;
  if (!detail) return <main><h1>Payment</h1><p>Loading payment...</p></main>;
  return <main><h1>Payment {detail.paymentId}</h1>
    <p>Provider: {detail.provider}</p><p>Status: {detail.status}</p>
    <p>Amount: {detail.amount.toFixed(2)} {detail.currency}</p>
    <p>Expected amount: {detail.expectedAmountCents == null ? "—" : `${detail.expectedAmountCents} cents`}</p>
    <p>Provider reference / Checkout Session: {detail.providerReference ?? "—"}</p>
    <p>Provider transaction / PaymentIntent: {detail.providerTransactionReference ?? "—"}</p>
    <p>Order: {detail.orderId ? <Link href={`/orders/${detail.orderId}`}>{detail.orderId}</Link> : "—"}</p>
    <p>Created: {new Date(detail.createdAt).toLocaleString()}</p><p>Updated: {new Date(detail.updatedAt).toLocaleString()}</p>
    {detail.status === "manual_refund_required" && <section role="alert"><h2>Manual refund required</h2><p>Confirm the payment, Session, PaymentIntent, EUR amount, and matching event classification below. During approved staging validation, use Stripe Dashboard TEST MODE and follow the Stripe staging runbook. Noctella does not issue or acknowledge the refund in this sprint.</p></section>}
    <h2>Payment events</h2><table><thead><tr><th>Provider event</th><th>Type</th><th>Status</th><th>Classification</th><th>Error</th><th>Created</th><th>Updated</th></tr></thead><tbody>{detail.events.map(event => <tr key={event.id}><td>{event.providerEventId}</td><td>{event.eventType}</td><td>{event.status}</td><td>{event.resultClassification ?? "—"}</td><td>{event.errorCode ?? "—"}</td><td>{new Date(event.createdAt).toLocaleString()}</td><td>{new Date(event.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>
  </main>;
}
