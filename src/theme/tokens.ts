// Theme tokens for Sens. Dark is the default; light is fully supported.
// Tokens are semantic (panel, dim, income, ...) so components never hardcode
// hex. The macOS-native look is carried by the system font stack, hairline
// borders, and SF Mono tabular figures for money.

export interface Theme {
  mode: "dark" | "light";
  font: string;
  mono: string;
  // surfaces
  bg: string;
  sidebar: string;
  panel: string;
  panel2: string;
  panel3: string;
  // text
  text: string;
  dim: string;
  faint: string;
  // lines
  border: string;
  borderStrong: string;
  divider: string;
  rowHover: string;
  // accent
  accent: string;
  onAccent: string;
  accentSoft: string;
  // semantic money colors (UI Color System)
  income: string;
  expense: string;
  transfer: string;
  adjustment: string;
  opening: string;
  negative: string; // negative balance text (reuses expense)
}

export function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

const DARK: Theme = {
  mode: "dark", font: FONT, mono: MONO,
  bg: "#0f1217", sidebar: "#0a0c10", panel: "#161b22", panel2: "#1b212a", panel3: "#222a35",
  text: "#e9eef5", dim: "#97a2b2", faint: "#5d6776",
  border: "rgba(255,255,255,0.07)", borderStrong: "rgba(255,255,255,0.13)", divider: "rgba(255,255,255,0.06)",
  rowHover: "rgba(255,255,255,0.035)",
  accent: "#33c9d6", onAccent: "#04181c", accentSoft: hexA("#33c9d6", 0.14),
  income: "#46d39a", expense: "#f0708c", transfer: "#5b8def", adjustment: "#e0a13c", opening: "#8893a5",
  negative: "#f0708c",
};

const LIGHT: Theme = {
  mode: "light", font: FONT, mono: MONO,
  bg: "#f4f5f7", sidebar: "#eaecf0", panel: "#ffffff", panel2: "#f3f5f8", panel3: "#e8ebf0",
  text: "#1a1f29", dim: "#5c6675", faint: "#909aa8",
  border: "rgba(0,0,0,0.09)", borderStrong: "rgba(0,0,0,0.15)", divider: "rgba(0,0,0,0.06)",
  rowHover: "rgba(0,0,0,0.035)",
  accent: "#0e9aa7", onAccent: "#ffffff", accentSoft: hexA("#0e9aa7", 0.13),
  income: "#16a34a", expense: "#dc2626", transfer: "#2563eb", adjustment: "#d97706", opening: "#475569",
  negative: "#dc2626",
};

export const THEMES = { dark: DARK, light: LIGHT };
export type ThemeMode = keyof typeof THEMES;
