import type { Metadata } from "next";
import Link from "next/link";
import { storefrontFooterItems, storefrontNavItems } from "@/config/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noctella",
  description: "Noctella — a collector's night sky.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "20px 40px",
            borderBottom: "1px solid var(--noctella-antique-gold)",
          }}
        >
          <Link href="/">
            <h1 style={{ fontSize: 24, margin: 0 }}>Noctella</h1>
          </Link>
          <nav style={{ display: "flex", gap: 24 }}>
            {storefrontNavItems.map((item) => (
              <Link key={item.href} href={item.href} style={{ fontSize: 14 }}>
                {item.label}
              </Link>
            ))}
            <Link href="/account" style={{ fontSize: 14 }}>
              Account
            </Link>
            <Link href="/wishlist" style={{ fontSize: 14 }}>
              Wishlist
            </Link>
            <Link href="/cart" style={{ fontSize: 14 }}>
              Cart
            </Link>
          </nav>
        </header>
        <main style={{ minHeight: "70vh" }}>{children}</main>
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
