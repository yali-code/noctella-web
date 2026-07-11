import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { storefrontFooterItems } from "@/config/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noctella — Objects With A Past",
  description: "Noctella — Nova Vita ex Praeterito. A collector's night sky.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
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
