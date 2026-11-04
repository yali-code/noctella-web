"use client";

import type { Product } from "@noctella/shared";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";

interface Props {
  productId: string;
  dirty: boolean;
  onFilled: (product: Product) => void;
}

/** One AI call fills Product Details, Pricing, SEO and all channel fields. Nothing is published; the admin reviews the form. */
export function ProductAiFillSection({ productId, dirty, onFilled }: Props) {
  const [running, setRunning] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleFill() {
    setRunning(true);
    setError(null);
    setDone(false);
    try {
      onFilled(await api.post<Product>(`/api/products/${productId}/ai-fill`, { replaceExisting }));
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "AI fill failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <p style={{ marginTop: 0, fontSize: 13 }}>
        Fills product details, pricing, SEO, eBay, Etsy and Noctella Web with one AI request. Values may be estimates: review them before publishing. Condition, stock, cost, notes and measurements are not changed.
      </p>
      <label style={{ display: "block", marginBottom: 10, fontSize: 13 }}>
        <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} disabled={running} /> Also replace existing text (prices and the warehouse condition note stay)
      </label>
      <button type="button" onClick={handleFill} disabled={running || dirty}>
        {running ? "Filling..." : "Fill all fields with AI"}
      </button>
      {dirty && <p style={{ fontSize: 13 }}>Save your changes first.</p>}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {done && <p style={{ fontSize: 13 }}>Fields filled. Review them, then publish.</p>}
    </div>
  );
}
