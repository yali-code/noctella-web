"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { OfferStatus, type Offer } from "@noctella/shared";
import { offersApi } from "@/lib/offers";

export default function OffersPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    offersApi.list().then(setOffers).catch((e) => setError(e?.message ?? "Failed to load offers"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: "accept" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      await (action === "accept" ? offersApi.accept(id) : offersApi.reject(id));
      load();
    } catch (e: any) {
      setError(e?.message ?? `Failed to ${action} offer`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Offers</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      {error && <p style={{ color: "var(--noctella-error, #b00020)" }}>{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Customer</th>
            <th>Offered Amount</th>
            <th>Currency</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => (
            <tr key={o.id}>
              <td><Link href={`/products/${o.productId}`}>{o.productId}</Link></td>
              <td>{o.customerName} ({o.customerEmail})</td>
              <td>{o.offeredAmount}</td>
              <td>{o.currency}</td>
              <td>{o.status}</td>
              <td>{o.createdAt}</td>
              <td>
                {o.status === OfferStatus.Pending ? (
                  <>
                    <button disabled={busyId === o.id} onClick={() => act(o.id, "accept")}>Accept</button>{" "}
                    <button disabled={busyId === o.id} onClick={() => act(o.id, "reject")}>Reject</button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
