import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { storefrontFooterItems } from "@/config/nav";
import { getStorefrontSiteUrl, SITE_DEFAULT_DESCRIPTION, SITE_DEFAULT_TITLE } from "@/lib/seo";
import "./globals.css";

/**
 * Sprint 73: metadataBase anchors every relative URL used in child pages' Open Graph/canonical
 * metadata to the real Storefront origin. The title template applies to any child page that sets
 * only a bare `title` string (not a full title object) - `%s` becomes that page's own title. No
 * route-specific canonical is set here deliberately: a canonical set at the root would apply to
 * every page underneath it, which is wrong - each page defines its own.
 */
export const metadata: Metadata = {
  metadataBase: new URL(getStorefrontSiteUrl()),
  title: {
    default: SITE_DEFAULT_TITLE,
    template: `%s — Noctella`,
  },
  description: SITE_DEFAULT_DESCRIPTION,
  openGraph: {
    siteName: "Noctella",
    title: SITE_DEFAULT_TITLE,
    description: SITE_DEFAULT_DESCRIPTION,
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="noctella-skip-link">
          Skip to main content
        </a>
        <Header />
        <main id="main-content" tabIndex={-1} style={{ minHeight: "70vh" }}>
          {children}
        </main>
        <footer
          style={{
            padding: "32px 40px",
            borderTop: "1px solid var(--noctella-antique-gold)",
            display: "flex",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          {storefrontFooterItems.map((item) => (
            <Link key={item.href} href={item.href} style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
              {item.label}
            </Link>
          ))}
        </footer>
      </body>
    </html>
  );
}
