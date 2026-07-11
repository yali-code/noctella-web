"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

interface MakeOfferFormProps {
  productId: string;
  productTitle: string;
}

export function MakeOfferForm({ productId, productTitle }: MakeOfferFormProps) {
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [offeredAmount, setOfferedAmount] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/offers", {
        productId,
        customerName,
        customerEmail,
        offeredAmount: Number(offeredAmount),
        currency: "EUR",
        message: message || undefined,
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="noctella-panel" style={{ padding: 20 }}>
        <p style={{ margin: 0 }}>
          Thank you — your offer for <strong>{productTitle}</strong> has been submitted. We&apos;ll be in
          touch by email.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="noctella-panel" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0 }}>Make an Offer</h3>
      {error && <p style={{ color: "#c86a6a", fontSize: 13, margin: 0 }}>{error}</p>}
      <label style={fieldLabelStyle}>
        Name
        <input
          required
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={fieldLabelStyle}>
        Email
        <input
          required
          type="email"
          value={customerEmail}
          onChange={(e) => setCustomerEmail(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={fieldLabelStyle}>
        Offered Amount (EUR)
        <input
          required
          type="number"
          min="0.01"
          step="0.01"
          value={offeredAmount}
          onChange={(e) => setOfferedAmount(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={fieldLabelStyle}>
        Message (optional)
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ ...inputStyle, minHeight: 70 }}
        />
      </label>
      <button type="submit" disabled={submitting} style={submitButtonStyle}>
        {submitting ? "Submitting..." : "Submit Offer"}
      </button>
    </form>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "var(--noctella-aged-bronze)",
};

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const submitButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  alignSelf: "flex-start",
};
