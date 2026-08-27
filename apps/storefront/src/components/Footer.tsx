import Link from "next/link";
import { storefrontFooterItems } from "@/config/nav";

export function Footer() {
  return (
    <footer className="sf-footer">
      <p><strong>Noctella</strong><br /><span>Nova Vita ex Praeterito</span></p>
      <nav aria-label="Footer navigation">
        {storefrontFooterItems.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
      </nav>
    </footer>
  );
}
