"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentAdmin, logout, type AdminIdentity } from "@/lib/auth";

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
  cursor: "pointer",
  width: "100%",
};

/**
 * Renders nothing when there is no valid session (including on /login itself, which shares this
 * root-layout-embedded control) - a small, reliable /api/auth/me lookup on mount, not a full
 * profile/settings feature.
 */
export function LogoutControl() {
  const router = useRouter();
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCurrentAdmin().then((id) => {
      if (!cancelled) setIdentity(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch {
      // Safe/idempotent even if the session was already gone - proceed to /login regardless.
    } finally {
      setBusy(false);
      router.replace("/login");
    }
  }

  if (!identity) return null;

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--noctella-antique-gold)", fontSize: 12 }}>
      <div style={{ marginBottom: 8, color: "var(--noctella-aged-bronze)" }}>
        {identity.email} ({identity.role})
      </div>
      <button onClick={handleLogout} disabled={busy} style={buttonStyle}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
