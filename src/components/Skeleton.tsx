// Skeleton: a shimmering placeholder block that matches the panel surface.
// Uses the `sens-shimmer` keyframe from ThemeProvider and theme tokens so it
// works in both dark and light modes without any hardcoded hex.

import type { CSSProperties } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 16, radius = 7, style = {} }: SkeletonProps) {
  const t = useTheme();
  // Shimmer travels from panel3 → panel2 → panel3 — subtle in both modes.
  const from = t.panel3;
  const mid = hexA(t.mode === "dark" ? "#ffffff" : "#000000", 0.06);
  return (
    <div
      className="sens-shimmer"
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundImage: `linear-gradient(90deg, ${from} 0%, ${mid} 50%, ${from} 100%)`,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
