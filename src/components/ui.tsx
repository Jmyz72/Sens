// Shared UI atoms, styled from the theme tokens. Inline styles (like the
// design prototype) with class-based hover/focus from ThemeProvider's base CSS.

import type { CSSProperties, ReactNode } from "react";
import { hexA } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { fmtMoney } from "../lib/format";
import { Icon, type IconName } from "./Icon";

export function Card({ children, style = {}, pad, onClick, className = "" }: { children: ReactNode; style?: CSSProperties; pad?: number; onClick?: () => void; className?: string }) {
  const t = useTheme();
  return (
    <div onClick={onClick} className={className}
      style={{ background: t.panel, border: `0.5px solid ${t.border}`, borderRadius: 13, padding: pad ?? 18, ...style }}>
      {children}
    </div>
  );
}

type BtnVariant = "primary" | "ghost" | "outline" | "danger";
export function Btn({ children, variant = "primary", icon, onClick, size = "md", disabled, style = {}, type }: {
  children: ReactNode; variant?: BtnVariant; icon?: IconName; onClick?: () => void; size?: "sm" | "md"; disabled?: boolean; style?: CSSProperties; type?: "button" | "submit";
}) {
  const t = useTheme();
  const h = size === "sm" ? 28 : 33;
  const base: CSSProperties = { height: h, padding: size === "sm" ? "0 11px" : "0 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, opacity: disabled ? 0.45 : 1, ...style };
  const variants: Record<BtnVariant, CSSProperties> = {
    primary: { background: t.accent, color: t.onAccent, boxShadow: `0 1px 8px ${hexA(t.accent, 0.35)}` },
    ghost: { background: "transparent", color: t.dim },
    outline: { background: "transparent", color: t.text, border: `0.5px solid ${t.borderStrong}` },
    danger: { background: "transparent", color: t.negative, border: `0.5px solid ${hexA(t.negative, 0.5)}` },
  };
  return (
    <button type={type ?? "button"} disabled={disabled} className={`sens-btn sens-btn-${variant}`} onClick={onClick} style={{ ...base, ...variants[variant] }}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 15} color={variant === "primary" ? t.onAccent : "currentColor"} stroke={2} />}
      {children}
    </button>
  );
}

export function IconBtn({ name, onClick, size = 30, icon = 17, color, title }: { name: IconName; onClick?: () => void; size?: number; icon?: number; color?: string; title?: string }) {
  const t = useTheme();
  return (
    <button className="sens-icon-btn" onClick={onClick} title={title} style={{ width: size, height: size, color: color || t.dim }}>
      <Icon name={name} size={icon} color="currentColor" />
    </button>
  );
}

export function Pill({ children, on, onClick, dot }: { children: ReactNode; on?: boolean; onClick?: () => void; dot?: string }) {
  const t = useTheme();
  return (
    <button className="sens-pill sens-btn" onClick={onClick}
      style={{ height: 28, padding: dot ? "0 11px 0 9px" : "0 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
        color: on ? t.accent : t.dim, backgroundColor: on ? t.accentSoft : undefined, border: `0.5px solid ${on ? "transparent" : t.border}` }}>
      {dot && <span style={{ width: 7, height: 7, borderRadius: 2, background: dot }} />}
      {children}
    </button>
  );
}

/** Emoji/glyph tile used for categories and accounts. */
export function GlyphTile({ tone, size = 28, emoji, icon, radius }: { tone: string; size?: number; emoji?: string; icon?: IconName; radius?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: radius ?? size * 0.32, background: hexA(tone, 0.16), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: size * 0.5 }}>
      {emoji ? emoji : icon ? <Icon name={icon} size={size * 0.54} color={tone} stroke={1.9} /> : null}
    </div>
  );
}

/** Money in SF Mono with tabular figures. `signed` adds +/− and colors by direction. */
export function Money({ cents, size = 13, weight = 600, color, signed = false, showCents = true }: {
  cents: number; size?: number; weight?: number; color?: string; signed?: boolean; showCents?: boolean;
}) {
  const t = useTheme();
  const sign = signed ? (cents > 0 ? "+" : cents < 0 ? "−" : "") : cents < 0 ? "−" : "";
  const c = color ?? (signed ? (cents > 0 ? t.income : cents < 0 ? t.expense : t.text) : cents < 0 ? t.negative : t.text);
  return (
    <span style={{ fontFamily: t.mono, fontWeight: weight, fontSize: size, color: c, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      {sign}{fmtMoney(cents, { cents: showCents })}
    </span>
  );
}

export function SectionTitle({ children, right, sub }: { children: ReactNode; right?: ReactNode; sub?: string }) {
  const t = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: t.text, letterSpacing: -0.2 }}>{children}</div>
        {sub && <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: t.dim, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
    </label>
  );
}

export function inputStyle(t: ReturnType<typeof useTheme>): CSSProperties {
  return { width: "100%", height: 38, background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 9, color: t.text, fontSize: 13.5, fontFamily: t.font, padding: "0 12px" };
}

export function Modal({ children, onClose, width = 420 }: { children: ReactNode; onClose: () => void; width?: number }) {
  const t = useTheme();
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: hexA("#05070b", t.mode === "dark" ? 0.6 : 0.32), backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 }}>
      <div className="sens-pop" onClick={(e) => e.stopPropagation()}
        style={{ width, maxHeight: "90vh", overflow: "auto", background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, hint, icon = "list" }: { title: string; hint?: string; icon?: IconName }) {
  const t = useTheme();
  return (
    <div style={{ padding: "48px 24px", textAlign: "center", color: t.faint }}>
      <div style={{ display: "inline-flex", marginBottom: 12 }}><Icon name={icon} size={28} color={t.faint} /></div>
      <div style={{ fontSize: 14, fontWeight: 600, color: t.dim }}>{title}</div>
      {hint && <div style={{ fontSize: 12.5, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
