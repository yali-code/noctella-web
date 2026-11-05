"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Breakdown {
  costSetId: string;
  costSetTitle: string;
  purchaseId: string | null;
  goodsEur: number;
  transportEur: number;
  fxDifferenceEur: number;
  totalEur: number;
}

const eur = (value: number) => `€${value.toFixed(2)}`;

/** Read-only cost lines from the approved invoice cost set. Renders nothing until one exists. */
export function ProductCostBreakdown({ productId, refreshKey }: { productId: string; refreshKey?: string }) {
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/erp/products/${encodeURIComponent(productId)}/cost-breakdown`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (active) setBreakdown(body?.breakdown ?? null); })
      .catch(() => { if (active) setBreakdown(null); });
    return () => { active = false; };
  }, [productId, refreshKey]);

  if (!breakdown) return null;
  const rows: Array<[string, number]> = [
    ["Goods (lot + hammer fee + premium)", breakdown.goodsEur],
    ["Transport", breakdown.transportEur],
    ["FX difference", breakdown.fxDifferenceEur],
  ];
  return (
    <div style={{ marginTop: 12, fontSize: 13 }}>
      <strong>Cost breakdown</strong>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span>{label}</span><span>{eur(value)}</span></div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontWeight: 700 }}><span>Purchase cost</span><span>{eur(breakdown.totalEur)}</span></div>
      <div style={{ marginTop: 4 }}>
        <Link href={`/invoice-cost-sets/${breakdown.costSetId}`}>{breakdown.costSetTitle}</Link>
        {breakdown.purchaseId && <> · <Link href={`/purchases/${breakdown.purchaseId}`}>Purchase</Link></>}
      </div>
    </div>
  );
}
