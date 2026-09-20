import type { CustomerEmailSender } from "./customerIdentity";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Production-only REST adapter. Tests inject CustomerEmailSender fakes; no message is sent without config. */
export function createCustomerEmailSender(): CustomerEmailSender {
  const key = process.env.CUSTOMER_EMAIL_RESEND_API_KEY;
  const address = process.env.CUSTOMER_EMAIL_FROM;
  const displayName = process.env.CUSTOMER_EMAIL_FROM_NAME ?? "Noctella";
  async function send(to: string, subject: string, link: string, action: string, expiry: string): Promise<void> {
    if (!key || !address) throw new Error("Customer transactional email is not configured");
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><h1>Noctella</h1><p>${escapeHtml(subject)}</p><p><a href="${safeLink}">${action}</a></p><p>This link expires in ${expiry}. If you did not request this, you can ignore this message.</p></div>`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${displayName} <${address}>`, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Customer transactional email could not be delivered");
  }
  return {
    sendVerification: (to, link) => send(to, "Verify your Noctella email", link, "Verify Email", "24 hours"),
    sendPasswordReset: (to, link) => send(to, "Reset your Noctella password", link, "Reset Password", "one hour"),
  };
}
