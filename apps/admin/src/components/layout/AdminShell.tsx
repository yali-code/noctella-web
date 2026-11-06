"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeMenuGroupLabel, adminMenuGroups } from "@/config/menu";
import { LogoutControl } from "@/components/auth/LogoutControl";

/**
 * Sprint 67: the sidebar/menu/LogoutControl previously rendered unconditionally around every
 * route, including /login - showing authenticated-looking chrome before any session exists.
 * usePathname() requires a Client Component, so this is split out of the (server) RootLayout
 * rather than adding "use client" to the whole layout.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const activeGroup = activeMenuGroupLabel(pathname);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []));

  useEffect(() => {
    if (activeGroup) setOpenGroups((current) => (current.has(activeGroup) ? current : new Set(current).add(activeGroup)));
  }, [activeGroup]);

  const toggle = (label: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  if (pathname === "/login") {
    return <>{children}</>;
  }

  return (
    <div className="noctella-admin-shell" style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        className="noctella-panel noctella-admin-sidebar"
        style={{
          width: 240,
          flexShrink: 0,
          padding: "24px 16px",
          borderRight: "1px solid var(--noctella-antique-gold)",
        }}
      >
        <h2 style={{ fontSize: 22, marginBottom: 24 }}>Noctella</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {adminMenuGroups.map((group) => {
            const open = openGroups.has(group.label);
            return (
              <li key={group.label} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(group.label)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "8px 10px",
                    border: "none",
                    borderRadius: 4,
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: 600,
                    color: group.label === activeGroup ? "var(--noctella-antique-gold)" : "var(--noctella-ivory)",
                  }}
                >
                  <span>{group.label}</span>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <ul style={{ listStyle: "none", margin: "0 0 6px", padding: "0 0 0 12px" }}>
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          style={{
                            display: "block",
                            padding: "6px 10px",
                            borderRadius: 4,
                            fontSize: 13,
                            textDecoration: "none",
                            color: "var(--noctella-ivory)",
                          }}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <LogoutControl />
      </nav>
      <main className="noctella-admin-main" style={{ flex: 1, padding: 32 }}>{children}</main>
    </div>
  );
}
