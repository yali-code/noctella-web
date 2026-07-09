import { ConstellationBackground } from "@/components/ConstellationBackground";

export default function HomePage() {
  return (
    <section style={{ position: "relative", padding: "80px 40px", textAlign: "center" }}>
      <ConstellationBackground />
      <div style={{ position: "relative" }}>
        <h1 style={{ fontSize: 48 }}>Noctella</h1>
        <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 560, margin: "16px auto" }}>
          A collector&apos;s night sky — rare pieces gathered under fixed stars.
        </p>
      </div>
    </section>
  );
}
