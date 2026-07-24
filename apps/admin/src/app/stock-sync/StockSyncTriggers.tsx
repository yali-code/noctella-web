"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PublishChannel } from "@noctella/shared";
import { channelLabel } from "@/lib/publishing";
import { syncAllChannels, syncChannel } from "@/lib/stockSyncJobs";

const CHANNELS = [PublishChannel.Ebay, PublishChannel.Etsy] as const;

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
  marginRight: 8,
  cursor: "pointer",
};

/** Fixed channel + all-channel triggers only - matches the backend's own hardcoded eBay/Etsy pair (routes/stockSync.ts's /marketplaces/all). No free-text action/channel input. */
export function StockSyncTriggers() {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState<string | null>(null);

  async function trigger(key: string, run: () => Promise<unknown>) {
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    setSucceeded(null);
    try {
      await run();
      setSucceeded(key);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger sync");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section>
      <h2>Manual sync</h2>
      {CHANNELS.map((channel) => (
        <button key={channel} disabled={busyKey !== null} style={buttonStyle} onClick={() => trigger(channel, () => syncChannel(channel))}>
          {busyKey === channel ? "Syncing…" : `Sync ${channelLabel(channel)}`}
        </button>
      ))}
      <button disabled={busyKey !== null} style={buttonStyle} onClick={() => trigger("all", syncAllChannels)}>
        {busyKey === "all" ? "Syncing…" : "Sync all channels"}
      </button>
      {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      {succeeded && <p style={{ color: "var(--noctella-bright-star-gold)" }}>Sync triggered.</p>}
    </section>
  );
}
