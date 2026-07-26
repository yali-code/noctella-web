import type { Metadata } from "next";

/**
 * Sprint 73: applies to /checkout and every nested route (/checkout/review, /checkout/payment,
 * /checkout/payment/confirm, /checkout/success) - transactional, personal, never indexed.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
