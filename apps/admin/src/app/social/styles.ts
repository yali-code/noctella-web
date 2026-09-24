import type { CSSProperties } from "react";
export const control: CSSProperties = { background: "var(--noctella-night-navy)", color: "var(--noctella-ivory)", border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: "8px 12px", font: "inherit" };
export const panel: CSSProperties = { padding: 20, marginBottom: 20 };
export const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 220px))", gap: 16 };
export const statusLabel = (status: string) => status.replaceAll("_", " ");
