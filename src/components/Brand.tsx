// The Sens brand mark: an "S" struck into a coin. Stroke-based so it renders
// crisply at any size; color is caller-controlled (dark glyph on the cyan tile).

import type { CSSProperties } from "react";

export function BrandMark({
  size = 18, color = "currentColor", style = {},
}: { size?: number; color?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: "block", flexShrink: 0, ...style }}>
      <circle cx="16" cy="16" r="11" stroke={color} strokeWidth="2.4" />
      <path
        d="M20 12 C20 9.6 12.8 9 12.8 12.8 C12.8 15.8 19.6 15.3 19.6 18.8 C19.6 22.4 12.2 21.8 11.4 19.4"
        fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round"
      />
    </svg>
  );
}
