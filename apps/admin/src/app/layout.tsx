import type { Metadata } from "next";
import { AdminShell } from "@/components/layout/AdminShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noctella Admin",
  description: "Noctella Web admin panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
