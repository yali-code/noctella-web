"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { getCurrentAdmin, login, safeNextPath } from "@/lib/auth";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
};
const buttonStyle: React.CSSProperties = { ...inputStyle, width: "auto", cursor: "pointer", marginTop: 12 };

/**
 * Reads ?next= from window.location directly (avoids next/navigation's useSearchParams, which
 * would otherwise require wrapping this page in a Suspense boundary for no real benefit here -
 * this value is only needed after mount, not during the initial render).
 */
function readNextParam(): string {
  if (typeof window === "undefined") return "/";
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentAdmin().then((identity) => {
      if (cancelled) return;
      if (identity) router.replace(readNextParam());
      else setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.replace(readNextParam());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sign in");
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading…</p>;

  return (
    <main style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>Noctella Admin</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <input style={inputStyle} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input style={inputStyle} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button type="submit" style={buttonStyle} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      </form>
    </main>
  );
}
