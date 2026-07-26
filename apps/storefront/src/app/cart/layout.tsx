import type { Metadata } from "next";

/** Sprint 73: guest-cart state has no SEO value and is personal to the visitor - never indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
