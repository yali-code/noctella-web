import type { Metadata } from "next";
import Link from "next/link";
import { adminMenuItems } from "@/config/menu";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noctella Admin",
  description: "Noctella Web admin panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <nav
            className="noctella-panel"
            style={{
              width: 240,
              flexShrink: 0,
              padding: "24px 16px",
              borderRight: "1px solid var(--noctella-antique-gold)",
            }}
          >
            <h2 style={{ fontSize: 22, marginBottom: 24 }}>Noctella</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {adminMenuItems.map((item) => (
                <li key={item.href} style={{ marginBottom: 4 }}>
                  <Link
                    href={item.href}
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      borderRadius: 4,
                      fontSize: 14,
                      textDecoration: "none",
                      color: "var(--noctella-ivory)",
                    }}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <main style={{ flex: 1, padding: 32 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
