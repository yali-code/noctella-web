import { ConstellationBackground } from "@/components/ConstellationBackground";

export default function AboutPage() {
  return (
    <section style={{ position: "relative", padding: "60px 40px" }}>
      <ConstellationBackground />
      <div style={{ position: "relative", maxWidth: 720 }}>
        <h1>About Noctella</h1>
        <p style={{ fontSize: 13, color: "var(--noctella-aged-bronze)", fontStyle: "italic" }}>
          Nova Vita ex Praeterito
        </p>
        <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 20, color: "var(--noctella-ivory)", lineHeight: 1.8 }}>
          <p>
            Noctella takes its name from the night — from stars, and from a sense of quiet magic. Our
            visual world is built around a fixed constellation: a deliberate, ordered arrangement of
            stars, not a scattering of random decoration. Every point of light has its place.
          </p>
          <p>
            At the heart of Noctella is the phoenix — a symbol of vintage objects reborn. Each piece we
            gather has already lived a life before it reaches us. We don&apos;t erase that history; we
            give it a new one.
          </p>
          <p>
            That idea is captured in our slogan, <em>Nova Vita ex Praeterito</em> — a new life from what
            came before.
          </p>
        </div>
      </div>
    </section>
  );
}
