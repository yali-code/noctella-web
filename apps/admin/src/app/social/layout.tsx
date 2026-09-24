import Link from "next/link";

export default function SocialLayout({ children }: { children: React.ReactNode }) {
  return <div><h1>Social Manager</h1>
    <p>Instagram · @noctella.vault</p>
    <nav aria-label="Social Manager" style={{ display: "flex", gap: 24, marginBottom: 24 }}>
      <Link href="/social">Content</Link><Link href="/social/media">Media Pool</Link><Link href="/social/new">Create content</Link>
    </nav>{children}</div>;
}
