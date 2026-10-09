"use client";

import { useEffect, useState } from "react";
import type { AdsConsentSnapshot } from "@/lib/adsEventPolicy";
import { denyAdsConsent } from "@/lib/adsEventPolicy";
import { CONSENT_STORAGE_KEY, readConsent, serializeConsent } from "@/lib/adsConsentStorage";

const accepted: AdsConsentSnapshot = { analytics: true, marketing: true, decisionRecorded: true };
const baseStyle: React.CSSProperties = { background: "#fffdf8", color: "#172033", border: "1px solid #b08d3f", borderRadius: 8, padding: 18, boxShadow: "0 8px 28px #0005" };
const buttonStyle: React.CSSProperties = { border: "1px solid #8b6b2e", background: "#fffdf8", color: "#172033", borderRadius: 4, padding: "10px 14px", cursor: "pointer", minHeight: 44 };

export function AdsConsentManager() {
  const [ready, setReady] = useState(false);
  const [decision, setDecision] = useState<AdsConsentSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    let prior: AdsConsentSnapshot | null = null;
    try { prior = readConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY)); } catch { /* Storage blocked: deny by default */ }
    setDecision(prior);
    setAnalytics(prior?.analytics === true);
    setMarketing(prior?.marketing === true);
    setReady(true);
    setOpen(!prior);
    const onOtherTabChange = (event: StorageEvent) => {
      if (event.key !== CONSENT_STORAGE_KEY && event.key !== null) return;
      // Treat removed, invalid or outdated consent as not decided.
      const updated = readConsent(event.newValue);
      setDecision(updated);
      setAnalytics(updated?.analytics === true);
      setMarketing(updated?.marketing === true);
      setStorageError(false);
      setOpen(!updated);
    };
    window.addEventListener("storage", onOtherTabChange);
    return () => window.removeEventListener("storage", onOtherTabChange);
  }, []);

  function save(next: AdsConsentSnapshot) {
    // A missing persisted decision denies tracking in the dispatcher. Never show
    // an accepted state if storage failed, including private browsing restrictions.
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, serializeConsent(next, new Date().toISOString()));
    } catch {
      setStorageError(true);
      setDecision(null);
      setAnalytics(false);
      setMarketing(false);
      setOpen(true);
      return;
    }
    setStorageError(false);
    setDecision(next);
    setAnalytics(next.analytics);
    setMarketing(next.marketing);
    setOpen(false);
    window.dispatchEvent(new Event("noctella:ads-consent-changed"));
  }

  if (!ready) return null;
  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-label="Cookie preferences"
          style={{ ...buttonStyle, position: "fixed", bottom: 12, left: 12, zIndex: 1000, fontSize: 12 }}>
          Cookie preferences
        </button>
      )}
      {open && (
        <section aria-label="Cookie consent" role="region" style={{ ...baseStyle, position: "fixed", bottom: 12, left: 12, right: 12, zIndex: 1001, maxWidth: 520, marginInline: "auto" }}>
          <h2 style={{ color: "#172033", margin: "0 0 8px", fontSize: 19 }}>Your privacy choices</h2>
          {storageError && <p role="alert" style={{ color: "#8c201b", fontSize: 14 }}>Your choices could not be saved in this browser. Optional tracking remains off. Please enable browser storage and try again.</p>}
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>Essential website features work without optional tracking. With your permission, analytics helps us improve the site, and marketing tools may measure interest in our collections. You can change your choices anytime.</p>
          <p style={{ fontSize: 13 }}>Essential: always on</p>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <input type="checkbox" checked={analytics} onChange={event => setAnalytics(event.target.checked)} /> Analytics
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <input type="checkbox" checked={marketing} onChange={event => setMarketing(event.target.checked)} /> Marketing
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={buttonStyle} onClick={() => save(denyAdsConsent())}>Reject optional</button>
            <button type="button" style={buttonStyle} onClick={() => save({ analytics, marketing, decisionRecorded: true })}>Save choices</button>
            <button type="button" style={{ ...buttonStyle, background: "#8b6b2e", color: "#fff" }} onClick={() => save(accepted)}>Accept all</button>
          </div>
        </section>
      )}
      <span data-ads-consent-recorded={decision?.decisionRecorded === true ? "yes" : "no"} hidden />
    </>
  );
}
