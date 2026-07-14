"use client";
import { useEffect, useState } from "react";
import { PublishChannel, type MarketplaceConnection } from "@noctella/shared";
import { MARKETPLACE_CHANNELS, marketplaceApi, safeError } from "@/lib/marketplaces";
export default function MarketplacesPage() {
  const [connections, setConnections] = useState<MarketplaceConnection[]>([]); const [message, setMessage] = useState("");
  const load = () => marketplaceApi.listConnections().then(setConnections).catch((e) => setMessage(e.message));
  useEffect(() => { void load(); }, []);
  const byChannel = (channel: PublishChannel) => connections.find((c) => c.channel === channel);
  return <div><h1>Marketplaces</h1>{message && <p>{safeError(message)}</p>}<div style={{display:"grid",gap:16}}>{MARKETPLACE_CHANNELS.map((channel) => { const c = byChannel(channel); return <section key={channel} className="noctella-panel" style={{padding:20}}><h2>{channel}</h2><p>Status: {c?.status ?? "disconnected"}</p><p>Expiry: {c?.tokenExpiresAt ?? "—"}</p><p>External account: {c?.externalAccountId ?? "—"}</p><p>{safeError(c?.lastError)}</p><button onClick={() => marketplaceApi.connect(channel).then((r) => setMessage(`Open authorization URL: ${r.authorizationUrl} state=${r.state}`)).catch((e)=>setMessage(e.message))}>Connect</button>{" "}<button onClick={() => marketplaceApi.verify(channel).then(load).catch((e)=>setMessage(e.message))}>Verify</button>{" "}<button onClick={() => marketplaceApi.refresh(channel).then(load).catch((e)=>setMessage(e.message))}>Refresh</button>{" "}<button onClick={() => marketplaceApi.disconnect(channel).then(load).catch((e)=>setMessage(e.message))}>Disconnect</button></section>; })}</div></div>;
}
