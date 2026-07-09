/**
 * Noctella brand theme tokens — dark navy luxury vintage, antique gold,
 * collector-shop feel. Consumed by both storefront and admin apps.
 *
 * Star/constellation motifs must use this fixed pattern set (see
 * `constellationPattern`) rather than randomly generated star fields.
 */
export const noctellaColors = {
  nightNavy: "#0B1220", // primary background
  deepStarBlue: "#141F35", // secondary surface / panels
  antiqueGold: "#B08D3F", // primary accent, borders, dividers
  brightStarGold: "#E8C577", // highlight accent, active states
  ivory: "#F3EFE6", // primary text on dark surfaces
  agedBronze: "#7A6A4F", // muted text, secondary accent
} as const;

export type NoctellaColorToken = keyof typeof noctellaColors;

export const noctellaTypography = {
  display: "'Cormorant Garamond', serif",
  body: "'Inter', sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const;

export const noctellaRadii = {
  sm: "2px",
  md: "4px",
  lg: "8px",
} as const;

/**
 * Fixed constellation coordinate set (percentage-based, viewBox 0 0 100 100).
 * Intentionally hand-placed, not randomly generated, so the pattern reads as
 * a designed sky rather than noise. Reused across storefront/admin surfaces
 * that want a starfield accent.
 */
export const constellationPattern: Array<{ x: number; y: number; r: number }> = [
  { x: 8, y: 12, r: 1.2 },
  { x: 18, y: 28, r: 0.8 },
  { x: 27, y: 8, r: 1.0 },
  { x: 34, y: 40, r: 1.4 },
  { x: 45, y: 18, r: 0.9 },
  { x: 52, y: 33, r: 1.1 },
  { x: 61, y: 12, r: 0.8 },
  { x: 68, y: 47, r: 1.3 },
  { x: 76, y: 24, r: 1.0 },
  { x: 84, y: 9, r: 0.9 },
  { x: 91, y: 38, r: 1.2 },
  { x: 14, y: 60, r: 1.0 },
  { x: 30, y: 72, r: 0.8 },
  { x: 48, y: 65, r: 1.3 },
  { x: 63, y: 78, r: 0.9 },
  { x: 79, y: 61, r: 1.1 },
  { x: 90, y: 82, r: 0.8 },
];

export const noctellaTheme = {
  colors: noctellaColors,
  typography: noctellaTypography,
  radii: noctellaRadii,
  constellationPattern,
} as const;
