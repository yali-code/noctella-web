import type { Metadata } from "next";

/** Sprint 73: personal account state has no SEO value - never indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
