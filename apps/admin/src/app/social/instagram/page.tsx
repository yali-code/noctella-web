"use client";
import { useCallback, useEffect, useState } from "react";
import { instagramConnectionApi, type InstagramConnection } from "@/lib/instagramConnection";
import { socialContentApi, type PublishingReadiness } from "@/lib/socialContent";
import { ApiError } from "@/lib/api";
import { control, panel, statusLabel } from "../styles";

const safeError = (err: unknown, fallback: string) => err instanceof ApiError ? err.message : fallback;

/**
 * Instagram/Vault connection administration. Page load reads local state only. Storing and
 * verifying are explicit operator actions that call Instagram's read-only identity endpoint and
 * never publish. The token lives only in this input until submitted, and is cleared afterwards.
 */
export default function InstagramConnectionPage() {
  const [connection, setConnection] = useState<InstagramConnection | null | undefined>(undefined);
  const [readiness, setReadiness] = useState<PublishingReadiness | null | "unavailable">(null);
  const [token, setToken] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [current, ready] = await Promise.allSettled([instagramConnectionApi.get(), socialContentApi.publishingReadiness()]);
    setConnection(current.status === "fulfilled" ? current.value : null);
    setReadiness(ready.status === "fulfilled" ? ready.value : "unavailable");
    if (current.status === "rejected") setError("Connection state could not be loaded.");
  }, []);
  useEffect(() => { load(); }, [load]);
  async function store() {
    const submitted = token;
    setToken(""); setBusy(true); setError(""); setMessage("");
    try {
      setConnection(await instagramConnectionApi.store(submitted, expiresAt ? new Date(expiresAt).toISOString() : null));
      setExpiresAt("");
      setMessage("Connection stored. Instagram confirmed the Vault account identity (read-only check, nothing was published).");
      await load();
    } catch (err) { setError(safeError(err, "The connection could not be stored.")); }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError(""); setMessage("");
    try {
      setConnection(await instagramConnectionApi.verify());
      setMessage("Connection verified with Instagram (read-only check, nothing was published).");
      await load();
    } catch (err) { setError(safeError(err, "The connection could not be verified.")); }
    finally { setBusy(false); }
  }
  return <section><h2>Instagram connection</h2>
    <p>Only the Noctella Vault account can be connected. Storing and verifying call Instagram&apos;s read-only account check; they never publish.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="noctella-panel" style={panel}>
      <h3>Current connection</h3>
      {connection === undefined ? <p role="status">Loading connection…</p> : !connection ? <p>No connection stored.</p> : <>
        <p>Status: {statusLabel(connection.status)}</p>
        <p>Account: {connection.accountLabel} · {connection.externalAccountId ?? "—"}</p>
        <p>Scopes: {connection.scopes.join(", ") || "—"}</p>
        <p>Token expires: {connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt).toLocaleString() : "not recorded"}</p>
        <p>Updated: {new Date(connection.updatedAt).toLocaleString()}</p>
        <button style={control} disabled={busy} onClick={verify}>Verify connection</button>
      </>}
    </div>
    <div className="noctella-panel" style={panel}>
      <h3>Publishing readiness</h3>
      {readiness === null ? <p role="status">Checking publishing readiness…</p>
        : readiness === "unavailable" ? <p>Publishing readiness is not available for your role.</p> : <>
          <p>Publishing readiness: {readiness.ready ? "Ready" : "Not ready — scheduled posts will fail safely without publishing"}</p>
          <p>Instagram connection: {statusLabel(readiness.connection)}</p>
          {!readiness.mediaOriginAllowed && <p>Media origin is not allowed for Instagram.</p>}
          {!!readiness.missingConfiguration.length && <p>Missing or invalid configuration: {readiness.missingConfiguration.join(", ")}</p>}
        </>}
    </div>
    <form className="noctella-panel" style={panel} onSubmit={(e) => { e.preventDefault(); if (token) store(); }}>
      <h3>Store or replace the token</h3>
      <label style={{ display: "grid", gap: 8 }}>Long-lived access token
        <input style={control} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <label style={{ display: "grid", gap: 8 }}>Token expires at (optional)
        <input style={control} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </label>
      <p>The token is encrypted on the server and is never shown again.</p>
      <button style={control} type="submit" disabled={busy || !token}>Store connection</button>
    </form>
  </section>;
}
