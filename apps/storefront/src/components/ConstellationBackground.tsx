import { constellationPattern } from "@noctella/shared";

/**
 * Fixed constellation/star-system accent — coordinates come from
 * @noctella/shared and are never randomly generated.
 */
export function ConstellationBackground() {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: 0.5,
      }}
    >
      {constellationPattern.map((star, i) => (
        <circle
          key={i}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="var(--noctella-bright-star-gold)"
        />
      ))}
    </svg>
  );
}
