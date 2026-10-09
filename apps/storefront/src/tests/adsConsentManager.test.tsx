// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdsConsentManager } from "@/components/AdsConsentManager";
import { CONSENT_STORAGE_KEY, readConsent, serializeConsent } from "@/lib/adsConsentStorage";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("ADS-002B.2 consent manager", () => {
  it("rejects stale, malformed, and incomplete stored decisions", () => {
    expect(readConsent(null)).toBeNull();
    expect(readConsent("invalid")).toBeNull();
    expect(readConsent('{"version":0,"analytics":true,"marketing":true,"savedAt":"2026-10-09"}')).toBeNull();
    expect(readConsent('{"version":1,"analytics":"yes","marketing":true,"savedAt":"2026-10-09"}')).toBeNull();
  });
  it("does not permit serialization of an undecided consent state", () => {
    expect(() => serializeConsent({ decisionRecorded: false, analytics: true, marketing: true }, "2026-10-09T00:00:00Z")).toThrow();
  });
  it("opens on an undecided first visit and rejects optional tracking", async () => {
    render(<AdsConsentManager />);
    const button = await screen.findByRole("button", { name: "Reject optional" });
    fireEvent.click(button);
    expect(readConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY))).toEqual({ analytics: false, marketing: false, decisionRecorded: true });
    expect(screen.queryByRole("region", { name: "Cookie consent" })).toBeNull();
  });
  it("saves granular choices and reopens settings to withdraw", async () => {
    render(<AdsConsentManager />);
    await screen.findByRole("region", { name: "Cookie consent" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Analytics" }));
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    expect(readConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY))).toEqual({ analytics: true, marketing: false, decisionRecorded: true });
    fireEvent.click(screen.getByRole("button", { name: "Cookie preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject optional" }));
    expect(readConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY))).toEqual({ analytics: false, marketing: false, decisionRecorded: true });
  });
  it("loads a prior explicit choice without showing the initial consent panel", async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, serializeConsent({ analytics: false, marketing: true, decisionRecorded: true }, "2026-10-09T00:00:00Z"));
    render(<AdsConsentManager />);
    await screen.findByRole("button", { name: "Cookie preferences" });
    expect(screen.queryByRole("region", { name: "Cookie consent" })).toBeNull();
  });
  it("accepts all only with an explicit button click", async () => {
    render(<AdsConsentManager />);
    await screen.findByRole("region", { name: "Cookie consent" });
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(readConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY))).toEqual({ analytics: true, marketing: true, decisionRecorded: true }));
  });
});
