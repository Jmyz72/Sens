// Reusable anchored action menu (the "⋯" overflow popover). Mirrors the
// EmojiPicker popover pattern: opens under a trigger, closes on outside-click
// / Esc. Disabled items are inert and surface their reason via the native
// title tooltip. All colors come from theme tokens.
import { useEffect, useMemo, useRef } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";

export interface ActionMenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a native tooltip on hover (used to explain a disabled item). */
  tooltip?: string;
  danger?: boolean;
}

export function ActionMenu({
  items,
  onClose,
  anchorRef,
}: {
  items: ActionMenuItem[];
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useTheme();
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click and Esc.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorRef, onClose]);

  // Position the menu under the anchor, right-aligned, flipping up on overflow.
  const pos = useMemo(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return { top: 0, left: 0 };
    const W = 188, gap = 6;
    const H = Math.min(items.length * 38 + 10, 360);
    let left = a.right - W;
    if (left < 8) left = 8;
    let top = a.bottom + gap;
    if (top + H > window.innerHeight - 8) top = Math.max(8, a.top - H - gap);
    return { top, left };
  }, [anchorRef, items.length]);

  return (
    <div ref={popRef} className="sens-pop"
      style={{
        position: "fixed", top: pos.top, left: pos.left, width: 188, zIndex: 200,
        background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 10,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)", padding: 5,
        display: "flex", flexDirection: "column", gap: 1,
      }}>
      {items.map((it) => {
        const color = it.disabled ? t.faint : it.danger ? t.expense : t.text;
        return (
          <button key={it.label} title={it.tooltip} disabled={it.disabled}
            onClick={() => { if (it.disabled) return; onClose(); it.onSelect(); }}
            style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "8px 10px", border: "none", borderRadius: 7,
              background: "transparent", color, cursor: it.disabled ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 550, textAlign: "left",
              opacity: it.disabled ? 0.6 : 1,
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = it.danger ? hexA(t.expense, 0.12) : t.panel2; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            {it.icon && <Icon name={it.icon} size={15} color={color} stroke={2} />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
