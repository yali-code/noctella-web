"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { adminMenuItems } from "@/config/menu";
import { LogoutControl } from "@/components/auth/LogoutControl";

/**
 * Sprint 67: the sidebar/menu/LogoutControl previously rendered unconditionally around every
 * route, including /login - showing authenticated-looking chrome before any session exists.
 * usePathname() requires a Client Component, so this is split out of the (server) RootLayout
 * rather than adding "use client" to the whole layout.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/login") {
    return <>{children}</>;
  }

  return (
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
        <LogoutControl />
      </nav>
      <main style={{ flex: 1, padding: 32 }}>{children}</main>
    </div>
  );
}
