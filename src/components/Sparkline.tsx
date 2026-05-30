// Tiny presentational SVG sparkline / area chart. Pure geometry lives in
// sparkPath so it is unit-testable; the component is a thin token-driven wrapper.
// Colors come from the caller (theme tokens) — no hardcoded hex.

import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";

export function sparkPath(points: number[], width: number, height: number, pad = 1): { line: string; area: string } {
  if (points.length === 0) return { line: "", area: "" };
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min;
  const n = points.length;
  const xs = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - 2 * pad));
  const ys = (v: number) => span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - 2 * pad);
  const line = points.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join("");
  const area = n > 1 ? `${line}L${xs(n - 1).toFixed(1)},${height}L${xs(0).toFixed(1)},${height}Z` : "";
  return { line, area };
}

export function Sparkline({ points, color, fill = false, width = 64, height = 28 }: {
  points: number[]; color: string; fill?: boolean; width?: number; height?: number;
}) {
  const t = useTheme();
  const { line, area } = sparkPath(points, width, height);
  if (!line) return <svg width={width} height={height} />;
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      {fill && area && <path d={area} fill={hexA(color, t.mode === "dark" ? 0.18 : 0.12)} stroke="none" />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
