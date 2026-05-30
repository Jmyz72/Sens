// Collapsible app sidebar: brand header + collapse toggle, net-worth card
// (expanded only), nav (full labels or an icon rail with hover tooltips), and
// the workspace/theme footer. Drag region kept minimal for macOS traffic lights.

import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import type { ThemeMode } from "../theme/tokens";
import { Icon } from "./Icon";
import { Money } from "./ui";
import { BrandMark } from "./Brand";
import { NAV, NAV_SECTIONS, type ScreenId } from "../nav";
import { fmtMonth } from "../lib/format";

interface Summary { netWorthCents: number; assetsCents: number; liabilitiesCents: number }

export function Sidebar({
  active, go, collapsed, onToggle, navCount, month, summary, loading, mode, onToggleTheme,
}: {
  active: ScreenId;
  go: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  navCount: (id: ScreenId) => number | null;
  month: string;
  summary: Summary;
  loading: boolean;
  mode: ThemeMode;
  onToggleTheme: () => void;
}) {
  const t = useTheme();

  // Clip overflow only during the collapse/expand width animation so content
  // doesn't visibly spill; allow overflow at rest so rail hover tooltips show.
  const [animating, setAnimating] = useState(false);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setAnimating(true);
    const id = window.setTimeout(() => setAnimating(false), 220);
    return () => window.clearTimeout(id);
  }, [collapsed]);

  return (
    <div className="sens-sidebar" style={{ width: collapsed ? 56 : 220, flexShrink: 0, background: t.sidebar, display: "flex", flexDirection: "column", borderRight: `0.5px solid ${t.border}`, overflow: animating ? "hidden" : "visible" }}>
      <div data-tauri-drag-region style={{ height: 28, flexShrink: 0 }} />

      {/* brand header + collapse toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "space-between", gap: 10, padding: collapsed ? "2px 0 10px" : "2px 12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${hexA(t.accent, 0.5)}`, flexShrink: 0 }}>
            <BrandMark size={17} color={t.onAccent} />
          </div>
          {!collapsed && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.3, lineHeight: 1.15 }}>Sens</div>
              <div style={{ fontSize: 11.5, color: t.faint, marginTop: 1 }}>Personal finance</div>
            </div>
          )}
        </div>
        {!collapsed && (
          <button className="sens-icon-btn" title="Collapse sidebar" onClick={onToggle} style={{ width: 26, height: 26, color: t.faint }}>
            <Icon name="chevronLeft" size={16} />
          </button>
        )}
      </div>

      {collapsed && (
        <button className="sens-icon-btn sens-tip" data-tip="Expand sidebar" title="Expand sidebar" onClick={onToggle} style={{ width: 30, height: 26, color: t.faint, alignSelf: "center", marginBottom: 8 }}>
          <Icon name="chevronRight" size={16} />
        </button>
      )}

      {/* net-worth card (expanded only; no Accounts count row) */}
      {!collapsed && (
        <div style={{ margin: "0 12px 14px", padding: 12, borderRadius: 10, background: t.panel, border: `0.5px solid ${t.border}`, boxShadow: `inset 0 1px 0 ${hexA(t.text, t.mode === "dark" ? 0.03 : 0.4)}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 10.5, color: t.faint, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>Net worth</div>
            <div style={{ fontSize: 11, color: t.dim, fontWeight: 600 }}>{fmtMonth(month)}</div>
          </div>
          <div style={{ marginTop: 7 }}>
            {loading ? (
              <span style={{ fontSize: 22, fontWeight: 750, color: t.faint }}>Loading</span>
            ) : (
              <Money cents={summary.netWorthCents} size={22} weight={750} showCents={false} />
            )}
          </div>
          <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, color: t.dim }}>
              <span>Assets</span>
              <Money cents={summary.assetsCents} size={12.5} weight={650} showCents={false} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, color: t.dim }}>
              <span>Debts</span>
              <Money cents={Math.abs(summary.liabilitiesCents)} size={12.5} weight={650} color={summary.liabilitiesCents < 0 ? t.negative : t.income} showCents={false} />
            </div>
          </div>
        </div>
      )}

      {/* nav */}
      <div style={{ padding: collapsed ? "0 8px" : "0 10px", display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
        {NAV_SECTIONS.map((section, si) => (
          <div key={section.label} style={{ marginTop: section.label === "Overview" ? 0 : 10 }}>
            {collapsed
              ? (si > 0 ? <div style={{ height: 1, background: t.divider, margin: "4px 6px 8px" }} /> : null)
              : <div style={{ fontSize: 10.5, color: t.faint, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, padding: "0 8px 7px" }}>{section.label}</div>}
            {section.items.map((id) => {
              const it = NAV.find((item) => item.id === id)!;
              const on = it.id === active;
              const count = navCount(it.id);
              return (
                <div key={it.id} className={collapsed ? "sens-nav sens-tip" : "sens-nav"} data-tip={collapsed ? it.label : undefined} onClick={() => go(it.id)}
                  style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "flex-start", gap: collapsed ? 0 : 11, height: 35, padding: collapsed ? 0 : "0 11px", borderRadius: 8,
                    backgroundColor: on ? t.accentSoft : undefined, color: on ? t.text : t.dim, fontWeight: on ? 600 : 500, fontSize: 13.5 }}>
                  <Icon name={it.icon} size={17} color={on ? t.accent : t.dim} stroke={on ? 2 : 1.7} />
                  {!collapsed && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>}
                  {!collapsed && count !== null && (
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: on ? t.accent : t.faint, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{count}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* footer */}
      <div style={{ padding: 10, borderTop: `0.5px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "space-between", gap: 8 }}>
        {!collapsed && (
          <div className="sens-nav" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 9, flex: 1 }}>
            <Icon name="wallet" size={16} color={t.dim} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Personal</div>
              <div style={{ fontSize: 11, color: t.faint, marginTop: 1 }}>Local workspace</div>
            </div>
          </div>
        )}
        <button className={collapsed ? "sens-icon-btn sens-tip" : "sens-icon-btn"} data-tip={collapsed ? (mode === "dark" ? "Light mode" : "Dark mode") : undefined} title="Toggle theme" onClick={onToggleTheme} style={{ width: 30, height: 30, color: t.dim }}>
          <Icon name={mode === "dark" ? "sun" : "moon"} size={16} />
        </button>
      </div>
    </div>
  );
}
