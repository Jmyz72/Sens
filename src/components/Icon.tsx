// Clean line icons drawn on a 24×24 grid, stroke-based so they read at any
// weight. Adapted from the Sens design prototype, extended for our needs.

import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "home" | "wallet" | "list" | "sparkle" | "search" | "bell" | "plus" | "minus"
  | "dots" | "arrowUp" | "arrowDown" | "chevronLeft" | "chevronRight" | "chevronDown"
  | "in" | "out" | "swap" | "sliders" | "sun" | "moon" | "pencil" | "archive"
  | "restore" | "trash" | "check" | "close" | "scale" | "filter"
  | "alertCircle" | "info" | "flag";

export function Icon({
  name, size = 18, stroke = 1.7, color = "currentColor", style = {},
}: { name: IconName; size?: number; stroke?: number; color?: string; style?: CSSProperties }) {
  const P = { fill: "none", stroke: color, strokeWidth: stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const dot = (cx: number, cy: number, r = 1.4) => <circle cx={cx} cy={cy} r={r} fill={color} stroke="none" />;
  const paths: Record<IconName, ReactNode> = {
    home: <path {...P} d="M4 10.5 12 4l8 6.5M6 9.5V20h12V9.5M10 20v-5h4v5" />,
    wallet: <>{<rect {...P} x="3.5" y="6" width="17" height="13" rx="2.5" />}<path {...P} d="M3.5 9.5h13a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-13" />{dot(16, 12.5, 1.1)}</>,
    list: <>{<path {...P} d="M8 7h12M8 12h12M8 17h12" />}{dot(4, 7, 1.1)}{dot(4, 12, 1.1)}{dot(4, 17, 1.1)}</>,
    sparkle: <path {...P} d="M12 4l1.6 5.4L19 11l-5.4 1.6L12 18l-1.6-5.4L5 11l5.4-1.6z" />,
    search: <>{<circle {...P} cx="11" cy="11" r="6" />}<path {...P} d="M16 16l4 4" /></>,
    bell: <>{<path {...P} d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />}<path {...P} d="M10 19a2 2 0 0 0 4 0" /></>,
    plus: <path {...P} d="M12 6v12M6 12h12" />,
    minus: <path {...P} d="M6 12h12" />,
    dots: <>{dot(5, 12, 1.5)}{dot(12, 12, 1.5)}{dot(19, 12, 1.5)}</>,
    arrowUp: <path {...P} d="M12 19V5M6 11l6-6 6 6" />,
    arrowDown: <path {...P} d="M12 5v14M6 13l6 6 6-6" />,
    chevronLeft: <path {...P} d="M15 6l-6 6 6 6" />,
    chevronRight: <path {...P} d="M9 6l6 6-6 6" />,
    chevronDown: <path {...P} d="M6 9l6 6 6-6" />,
    in: <>{<circle {...P} cx="12" cy="12" r="8" />}<path {...P} d="M12 8v8M8.5 12.5 12 16l3.5-3.5" /></>,
    out: <>{<circle {...P} cx="12" cy="12" r="8" />}<path {...P} d="M12 16V8M8.5 11.5 12 8l3.5 3.5" /></>,
    swap: <path {...P} d="M6 8h12l-3-3M18 16H6l3 3" />,
    sliders: <>{<path {...P} d="M5 8h9M18 8h1M5 16h1M10 16h9" />}{<circle {...P} cx="16" cy="8" r="2" />}{<circle {...P} cx="8" cy="16" r="2" />}</>,
    sun: <>{<circle {...P} cx="12" cy="12" r="4" />}<path {...P} d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" /></>,
    moon: <path {...P} d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />,
    pencil: <>{<path {...P} d="M5 19h3l9-9-3-3-9 9z" />}<path {...P} d="M13.5 6.5l3 3" /></>,
    archive: <>{<rect {...P} x="4" y="5" width="16" height="4" rx="1" />}<path {...P} d="M5.5 9v8.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>,
    restore: <>{<path {...P} d="M4 9a8 8 0 1 1-1 4" />}<path {...P} d="M4 4v5h5" /></>,
    trash: <path {...P} d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />,
    check: <path {...P} d="M5 12.5l4.5 4.5L19 7" />,
    close: <path {...P} d="M7 7l10 10M17 7L7 17" />,
    scale: <>{<path {...P} d="M12 4v16M7 7h10" />}<path {...P} d="M7 7l-3 6a3 3 0 0 0 6 0zM17 7l-3 6a3 3 0 0 0 6 0z" /></>,
    filter: <path {...P} d="M4 6h16l-6 7v5l-4 2v-7z" />,
    alertCircle: <>{<circle {...P} cx="12" cy="12" r="9" />}<path {...P} d="M12 8v5" />{dot(12, 15.5, 1.1)}</>,
    info: <>{<circle {...P} cx="12" cy="12" r="9" />}<path {...P} d="M12 16v-5" />{dot(12, 8.5, 1.1)}</>,
    flag: <path {...P} d="M6 21V4M6 4h11l-2.2 4L17 12H6" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", flexShrink: 0, ...style }}>
      {paths[name]}
    </svg>
  );
}
