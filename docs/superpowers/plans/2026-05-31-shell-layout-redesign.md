# Shell Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Sens app shell — collapsible sidebar, Transaction-only top-bar Add, account creation moved to the Accounts screen, a new "Coin S" brand mark, and removal of the sidebar top gap — while keeping the theme unchanged.

**Architecture:** Extract the sidebar and top bar out of the 440-line `App.tsx` into focused `Sidebar.tsx` / `TopBar.tsx` components, with shared nav config in `src/nav.ts` and the brand mark in `src/components/Brand.tsx`. `App.tsx` keeps app-data/state, screen routing, the localStorage-backed collapse flag, and the AddTransaction modal. Pure presentational shell — no backend, command, or mock-seam changes (one regenerated icon asset).

**Tech Stack:** React 19 + TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`), Vite, inline styles + theme tokens, Tauri v2 CLI for icon generation.

**Spec:** `docs/superpowers/specs/2026-05-31-sens-shell-layout-redesign-design.md`

**Testing approach:** Vitest runs in the `node` environment (`vite.config.ts`) with no DOM — the existing suite is pure-logic only, and there is no React component-rendering harness. This shell work is presentational, so each task is verified by the **strict TypeScript build** (`npm run build`) and the **existing test suite staying green** (`npm test`), plus manual checks noted per task. We do **not** add jsdom or fabricate render tests (out of scope, against the codebase's established pattern).

**Branch:** `feat/shell-layout-redesign` (already checked out; the design spec is already committed here).

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/nav.ts` *(new)* | Shared nav config: `ScreenId` type, `NAV`, `NAV_SECTIONS`. Consumed by `App`, `Sidebar`, `TopBar`. |
| `src/components/Brand.tsx` *(new)* | `BrandMark` — the Coin S SVG logo. |
| `src/components/Sidebar.tsx` *(new)* | Collapsible sidebar: brand header + collapse toggle, net-worth card (expanded only, no Accounts row), nav (full or icon rail with tooltips), footer/theme toggle, 28px drag region. |
| `src/components/TopBar.tsx` *(new)* | Top bar: title/subtitle, dashboard month picker, Transaction-only Add button. |
| `src/App.tsx` *(modify)* | Compose `Sidebar`+`TopBar`; own collapse state (localStorage); drop the Add menu, `showAcct`, and `AddAccount`. |
| `src/screens/Accounts.tsx` *(modify)* | "Add account" button + locally-owned `AddAccount` modal; updated empty-state hint. |
| `src/theme/ThemeProvider.tsx` *(modify)* | Add sidebar width transition + rail tooltip CSS. |
| `src-tauri/icons/source-icon.svg` *(new)* | 1024×1024 Coin S source art. |
| `src-tauri/icons/*` *(regenerated)* | Platform icon set from the new source. |
| `CLAUDE.md`, `CHANGELOG.md` *(modify)* | Docs + changelog. |

Tasks are ordered so the build stays green after every commit (new components are created before `App.tsx` consumes them).

---

## Task 1: Shared nav config (`src/nav.ts`)

**Files:**
- Create: `src/nav.ts`

- [ ] **Step 1: Create the nav module**

```tsx
// Shared navigation config for the shell (sidebar + top bar).

import type { IconName } from "./components/Icon";

export type ScreenId = "dashboard" | "accounts" | "transactions" | "categories" | "settings";

export const NAV: { id: ScreenId; label: string; icon: IconName; sub: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "home", sub: "Your money at a glance" },
  { id: "accounts", label: "Accounts", icon: "wallet", sub: "All balances in one place" },
  { id: "transactions", label: "Transactions", icon: "list", sub: "Every ringgit in and out" },
  { id: "categories", label: "Categories", icon: "filter", sub: "Income, expense & transfer labels" },
  { id: "settings", label: "Settings", icon: "sliders", sub: "Preferences and about" },
];

export const NAV_SECTIONS: { label: string; items: ScreenId[] }[] = [
  { label: "Overview", items: ["dashboard"] },
  { label: "Money", items: ["accounts", "transactions", "categories"] },
  { label: "System", items: ["settings"] },
];
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS (new file compiles; `NAV`/`NAV_SECTIONS` are unused for now, but module-level exports don't trip `noUnusedLocals`).

- [ ] **Step 3: Commit**

```bash
git add src/nav.ts
git commit -m "refactor(shell): extract shared nav config to src/nav.ts"
```

---

## Task 2: Coin S brand mark (`src/components/Brand.tsx`)

**Files:**
- Create: `src/components/Brand.tsx`

- [ ] **Step 1: Create the brand component**

```tsx
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
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/Brand.tsx
git commit -m "feat(shell): add Coin S brand mark component"
```

---

## Task 3: Sidebar transition + rail tooltip CSS

**Files:**
- Modify: `src/theme/ThemeProvider.tsx` (the `baseCss` template, ~lines 47–73)

- [ ] **Step 1: Add the sidebar/tooltip CSS**

In `baseCss`, immediately after the `.sens-nav:hover` rule (currently line 48), insert the sidebar width transition and rail tooltip rules:

```css
    .sens-sidebar{transition:width .18s cubic-bezier(.2,.7,.3,1);}
    .sens-tip{position:relative;}
    .sens-tip::after{content:attr(data-tip);position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);background:${t.panel2};color:${t.text};border:0.5px solid ${t.borderStrong};font-size:12px;font-weight:600;padding:4px 9px;border-radius:7px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s;z-index:80;box-shadow:0 8px 24px rgba(0,0,0,0.3);}
    .sens-tip:hover::after{opacity:1;}
```

So the block reads:

```css
    .sens-nav{cursor:pointer;transition:background-color .12s,color .12s;}
    .sens-nav:hover{background-color:var(--row-hover);}
    .sens-sidebar{transition:width .18s cubic-bezier(.2,.7,.3,1);}
    .sens-tip{position:relative;}
    .sens-tip::after{content:attr(data-tip);position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);background:${t.panel2};color:${t.text};border:0.5px solid ${t.borderStrong};font-size:12px;font-weight:600;padding:4px 9px;border-radius:7px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s;z-index:80;box-shadow:0 8px 24px rgba(0,0,0,0.3);}
    .sens-tip:hover::after{opacity:1;}
    .sens-row{transition:background-color .12s;}
```

- [ ] **Step 2: Disable the width transition under reduced motion**

In the existing `@media (prefers-reduced-motion: reduce)` rule (currently line 73), add `.sens-sidebar` to the selectors that null out animation/transition:

```css
    @media (prefers-reduced-motion: reduce){.sens-shimmer{animation:none;}.sens-screen{animation:none;}.sens-pop{animation:none;}.sens-sidebar{transition:none;}}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/theme/ThemeProvider.tsx
git commit -m "feat(shell): sidebar width transition + rail tooltip styles"
```

---

## Task 4: Sidebar component (`src/components/Sidebar.tsx`)

**Files:**
- Create: `src/components/Sidebar.tsx`

Note: this is the full sidebar markup (expanded + collapsed), lifted from `App.tsx:141-217` with these changes baked in: 30px gap fix (46→28 drag region), collapse toggle, icon-rail mode with tooltips, the BrandMark replacing the sparkle, and the **net-worth "Accounts" count row removed**.

- [ ] **Step 1: Create the component**

```tsx
// Collapsible app sidebar: brand header + collapse toggle, net-worth card
// (expanded only), nav (full labels or an icon rail with hover tooltips), and
// the workspace/theme footer. Drag region kept minimal for macOS traffic lights.

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

  return (
    <div className="sens-sidebar" style={{ width: collapsed ? 56 : 220, flexShrink: 0, background: t.sidebar, display: "flex", flexDirection: "column", borderRight: `0.5px solid ${t.border}`, overflow: "hidden" }}>
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
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS. (`Sidebar` is unused until Task 6 — exported functions are fine under `noUnusedLocals`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(shell): collapsible Sidebar component with icon rail + tooltips"
```

---

## Task 5: TopBar component (`src/components/TopBar.tsx`)

**Files:**
- Create: `src/components/TopBar.tsx`

Lifted from `App.tsx:221-250`, with the Add dropdown replaced by a single Transaction Add button.

- [ ] **Step 1: Create the component**

```tsx
// Top bar: screen title/subtitle, the dashboard month picker, and the Add
// button (Transaction only — account creation lives on the Accounts screen).

import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./Icon";
import { Btn } from "./ui";
import { fmtMonth } from "../lib/format";

export function TopBar({
  title, sub, isDashboard, month, onShiftMonth, onAddTransaction,
}: {
  title: string;
  sub: string;
  isDashboard: boolean;
  month: string;
  onShiftMonth: (delta: number) => void;
  onAddTransaction: () => void;
}) {
  const t = useTheme();
  return (
    <div data-tauri-drag-region style={{ height: 60, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: `0.5px solid ${t.divider}` }}>
      <div style={{ minWidth: 88, flex: "1 1 auto" }}>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: 12, color: t.faint, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
      <div style={{ flex: 1 }} />
      {isDashboard && (
        <div style={{ display: "flex", alignItems: "center", gap: 2, background: t.panel, borderRadius: 8, border: `0.5px solid ${t.border}`, padding: 2 }}>
          <button className="sens-icon-btn" onClick={() => onShiftMonth(-1)} style={{ width: 26, height: 26, color: t.dim }}><Icon name="chevronLeft" size={15} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 92, textAlign: "center" }}>{fmtMonth(month)}</span>
          <button className="sens-icon-btn" onClick={() => onShiftMonth(1)} style={{ width: 26, height: 26, color: t.dim }}><Icon name="chevronRight" size={15} /></button>
        </div>
      )}
      <Btn icon="plus" onClick={onAddTransaction}>Add</Btn>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/TopBar.tsx
git commit -m "feat(shell): TopBar component with Transaction-only Add"
```

---

## Task 6: Rewrite `App.tsx` to compose the shell

**Files:**
- Modify: `src/App.tsx` (full replacement)

This removes the inline sidebar/top-bar JSX, the `NAV`/`NAV_SECTIONS` defs (now in `src/nav.ts`), the Add dropdown (`addOpen`), and account creation (`showAcct` + `AddAccount`); adds the localStorage-backed `collapsed` flag; and composes `<Sidebar>` + `<TopBar>`. All app-data/state, effects, month logic, and the AddTransaction modal are preserved verbatim.

- [ ] **Step 1: Replace the entire file contents**

```tsx
// App shell: composes the collapsible sidebar + top bar, routes screens, owns
// month navigation and the app-data store (accounts + categories), persists the
// sidebar collapse state, and refreshes screens via a version counter.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme, useThemeMode } from "./theme/ThemeProvider";
import { useToast } from "./components/Toast";
import { AppDataCtx } from "./store";
import type { Account, Category } from "./types";
import { client } from "./client";
import { currentMonth, shiftMonth } from "./lib/format";
import { sidebarPortfolioSummary } from "./lib/accounts";
import { useUpdater } from "./lib/updater";
import { NAV, type ScreenId } from "./nav";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Dashboard } from "./screens/Dashboard";
import { Accounts } from "./screens/Accounts";
import { Transactions } from "./screens/Transactions";
import { Settings } from "./screens/Settings";
import { Categories } from "./screens/Categories";
import { AddTransaction } from "./modals/AddTransaction";

const SIDEBAR_KEY = "sens.sidebar";

export default function App() {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();
  const { notify } = useToast();
  const updater = useUpdater();
  const { checkForUpdates, desktop: updaterDesktop, state: updateState } = updater;
  const [active, setActive] = useState<ScreenId>("dashboard");
  const [month, setMonth] = useState(currentMonth());
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_KEY) === "collapsed");

  // Persist the collapse state whenever it changes.
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); }, [collapsed]);

  // On mount: if remember_month is on, restore the last viewed month.
  useEffect(() => {
    client.getSetting("remember_month").then((v) => {
      if (v === "1") {
        client.getSetting("dashboard_month").then((m) => {
          if (m) setMonth(m);
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // Persist the month whenever it changes (only if remember_month is on).
  const handleSetMonth = useCallback((updater: (m: string) => string) => {
    setMonth((prev) => {
      const next = updater(prev);
      client.getSetting("remember_month").then((v) => {
        if (v === "1") client.setSetting("dashboard_month", next).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [showTxn, setShowTxn] = useState(false);
  const [txnAccountId, setTxnAccountId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([client.listAccounts(false), client.listCategories()]);
      setAccounts(a); setCategories(c); setLoading(false);
      setVersion((v) => v + 1);
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Failed to reload data", "error");
    }
  }, [notify]);

  useEffect(() => { reload(); }, [reload]);

  const updateToastShown = useRef(false);
  useEffect(() => {
    if (!updaterDesktop) return;
    const handle = window.setTimeout(() => {
      void checkForUpdates();
    }, 3500);
    return () => window.clearTimeout(handle);
  }, [checkForUpdates, updaterDesktop]);

  useEffect(() => {
    if (updateState.status !== "available" || updateToastShown.current) return;
    updateToastShown.current = true;
    notify(`Sens ${updateState.latestVersion} is available in Settings.`, "info");
  }, [notify, updateState.latestVersion, updateState.status]);

  // One-time notice after the v1.1 migration reclassified accounts into owe
  // groups (credit/loans/borrowed). Suppressed forever after first display.
  const oweNoticeChecked = useRef(false);
  useEffect(() => {
    if (loading || oweNoticeChecked.current) return;
    oweNoticeChecked.current = true;
    client.getSetting("owe_notice_shown").then((seen) => {
      if (seen) return;
      if (accounts.some((a) => a.group === "owe")) {
        notify("Some accounts are now treated as debts — review their balances.", "info");
      }
      void client.setSetting("owe_notice_shown", "1");
    }).catch(() => {});
  }, [loading, accounts, notify]);

  const data = useMemo(() => ({ accounts, categories, loading, reload, version }), [accounts, categories, loading, reload, version]);
  const nav = NAV.find((n) => n.id === active)!;
  const portfolioSummary = useMemo(() => sidebarPortfolioSummary(accounts), [accounts]);
  const activeAccountCount = useMemo(() => accounts.filter((a) => !a.isArchived).length, [accounts]);
  const activeCategoryCount = useMemo(() => categories.filter((c) => !c.isArchived).length, [categories]);
  const go = (id: string, opts?: { accountId?: string }) => {
    setActive(id as ScreenId);
    setTxnAccountId(opts?.accountId ?? null);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const navCount = (id: ScreenId) => {
    if (id === "accounts") return activeAccountCount;
    if (id === "categories") return activeCategoryCount;
    return null;
  };

  return (
    <AppDataCtx.Provider value={data}>
      <div className="sens" style={{ position: "fixed", inset: 0, display: "flex", background: t.bg, color: t.text, fontFamily: t.font }}>
        <Sidebar
          active={active}
          go={go}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          navCount={navCount}
          month={month}
          summary={portfolioSummary}
          loading={loading}
          mode={mode}
          onToggleTheme={toggle}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar
            title={nav.label}
            sub={nav.sub}
            isDashboard={active === "dashboard"}
            month={month}
            onShiftMonth={(d) => handleSetMonth((m) => shiftMonth(m, d))}
            onAddTransaction={() => setShowTxn(true)}
          />

          <div ref={scroller} style={{ flex: 1, overflow: "auto", padding: 24 }}>
            {active === "dashboard" && <Dashboard month={month} go={go} />}
            {active === "accounts" && <Accounts go={go} />}
            {active === "transactions" && <Transactions initialAccountId={txnAccountId} />}
            {active === "categories" && <Categories />}
            {active === "settings" && <Settings updater={updater} />}
          </div>
        </div>

        {showTxn && <AddTransaction accounts={accounts} categories={categories} onClose={() => setShowTxn(false)} onDone={() => { setShowTxn(false); reload(); }} />}
      </div>
    </AppDataCtx.Provider>
  );
}
```

- [ ] **Step 2: Verify the build (catches any stale imports / unused symbols)**

Run: `npm run build`
Expected: PASS with no `noUnusedLocals`/`noUnusedParameters` errors. If it complains about an unused import, it means a symbol that moved into a subcomponent is still imported here — remove it.

- [ ] **Step 3: Run the test suite (regression guard)**

Run: `npm test`
Expected: PASS (all existing suites green; no logic changed).

- [ ] **Step 4: Manual smoke check (browser mock)**

Run: `npm run dev`, open the served URL. Verify: sidebar shows the new Coin S mark with no big gap above it; collapse chevron toggles to a 56px icon rail; hovering rail icons shows label tooltips; net-worth card hides when collapsed; reloading the page preserves the collapsed/expanded state; the top-bar **Add** button opens the Add Transaction modal directly (no dropdown).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(shell): compose collapsible Sidebar + TopBar; Add is Transaction-only

Sidebar collapse state persisted to localStorage. Removes the top-bar Add
dropdown and the App-owned AddAccount modal (account creation moves to the
Accounts screen). Brand mark + 28px drag region land via the new components."
```

---

## Task 7: Account creation on the Accounts screen

**Files:**
- Modify: `src/screens/Accounts.tsx`

- [ ] **Step 1: Import `AddAccount` and add local modal state**

Add the import alongside the other modal imports (near `src/screens/Accounts.tsx:18-19`):

```tsx
import { SetBalance } from "../modals/SetBalance";
import { EditAccount } from "../modals/EditAccount";
import { AddAccount } from "../modals/AddAccount";
```

Add the state next to the other `useState` hooks (after line 54, `const [editing, setEditing] = ...`):

```tsx
  const [showAdd, setShowAdd] = useState(false);
```

- [ ] **Step 2: Add the "Add account" button to the header**

Replace the single-button block (currently `src/screens/Accounts.tsx:120`):

```tsx
            <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
```

with a two-button row:

```tsx
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
              <Btn size="sm" icon="plus" onClick={() => setShowAdd(true)}>Add account</Btn>
            </div>
```

- [ ] **Step 3: Update the empty-state hint**

Replace (currently `src/screens/Accounts.tsx:125`):

```tsx
      {visible.length === 0 && <Card><Empty icon="wallet" title="No accounts yet" hint="Create one from the Add menu." /></Card>}
```

with:

```tsx
      {visible.length === 0 && <Card><Empty icon="wallet" title="No accounts yet" hint="Create one with the Add account button." /></Card>}
```

- [ ] **Step 4: Render the `AddAccount` modal alongside the other modals**

After the `editing` modal line (currently `src/screens/Accounts.tsx:243`), add:

```tsx
      {showAdd && <AddAccount onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); void afterMutation(); }} />}
```

So the modal block reads:

```tsx
      {correcting && <SetBalance account={correcting} hasTransactions={(txnsByAccount.get(correcting.id)?.length ?? 0) > 0 || correcting.balanceCents !== correcting.openingBalanceCents} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); afterMutation(); }} />}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); afterMutation(); }} />}
      {showAdd && <AddAccount onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); void afterMutation(); }} />}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Run the test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Manual check**

In `npm run dev`: go to Accounts → click **Add account** → the modal opens and creates an account; the new account appears and the sidebar/nav counts update. With zero accounts, the empty state reads "Create one with the Add account button."

- [ ] **Step 8: Commit**

```bash
git add src/screens/Accounts.tsx
git commit -m "feat(accounts): add account creation button + modal on the Accounts screen"
```

---

## Task 8: Regenerate the OS app icons from the Coin S mark

**Files:**
- Create: `src-tauri/icons/source-icon.svg`
- Create: `src-tauri/icons/source-icon.png` (rasterized)
- Regenerate: `src-tauri/icons/*` (32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico, Square*Logo.png, StoreLogo.png)

The hex literals here are brand asset constants (`accent` `#33c9d6`, `onAccent` `#04181c`), which CLAUDE.md permits as raw hex in data/assets.

- [ ] **Step 1: Write the 1024×1024 source SVG**

Create `src-tauri/icons/source-icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="230" fill="#33c9d6"/>
  <g transform="translate(512,512) scale(22) translate(-16,-16)" fill="none" stroke="#04181c" stroke-linecap="round">
    <circle cx="16" cy="16" r="11" stroke-width="2.4"/>
    <path d="M20 12 C20 9.6 12.8 9 12.8 12.8 C12.8 15.8 19.6 15.3 19.6 18.8 C19.6 22.4 12.2 21.8 11.4 19.4" stroke-width="2.6"/>
  </g>
</svg>
```

- [ ] **Step 2: Rasterize the SVG to a 1024×1024 PNG**

On macOS (no extra install needed — QuickLook renders SVG):

Run:
```bash
qlmanage -t -s 1024 -o src-tauri/icons src-tauri/icons/source-icon.svg && mv src-tauri/icons/source-icon.svg.png src-tauri/icons/source-icon.png
```
Expected: creates `src-tauri/icons/source-icon.png` at 1024×1024.

(Alternative if `rsvg-convert` is installed: `rsvg-convert -w 1024 -h 1024 src-tauri/icons/source-icon.svg -o src-tauri/icons/source-icon.png`. Any SVG→PNG rasterizer producing a 1024×1024 square PNG is fine.)

Verify the dimensions:
```bash
sips -g pixelWidth -g pixelHeight src-tauri/icons/source-icon.png
```
Expected: `pixelWidth: 1024`, `pixelHeight: 1024`. If smaller, re-run with a tool that honors 1024.

- [ ] **Step 3: Generate the platform icon set**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri icon src-tauri/icons/source-icon.png
```
Expected: overwrites `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, and the `Square*Logo.png` / `StoreLogo.png` set. `tauri.conf.json` already references these paths, so no config edit is needed.

- [ ] **Step 4: Validate the desktop build bundles the new icons**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build && cd ..
```
Expected: compiles cleanly (confirms the icon assets are valid for bundling).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/icons/
git commit -m "feat(brand): regenerate app icons from Coin S mark"
```

---

## Task 9: Documentation + changelog

**Files:**
- Modify: `CLAUDE.md` (Frontend conventions — shell description)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Update the shell description in `CLAUDE.md`**

In the "Frontend conventions" section, find the bullet referencing the shell/atoms (the line beginning "New work uses the existing atoms in `src/components/ui.tsx`…") and add a new bullet immediately after it:

```markdown
- The app **shell** is composed in `src/App.tsx` from `src/components/Sidebar.tsx` (collapsible: full 220px ↔ 56px icon rail with hover tooltips, collapse state persisted to `localStorage` under `sens.sidebar`; net-worth card shown only when expanded) and `src/components/TopBar.tsx` (title/subtitle, dashboard month picker, and a **Transaction-only** Add button). Nav config lives in `src/nav.ts`; the brand mark is `src/components/Brand.tsx` (Coin S). **Account creation lives on the Accounts screen** (`src/screens/Accounts.tsx` owns the `AddAccount` modal), not the top bar.
```

- [ ] **Step 2: Add a `[Unreleased]` changelog entry**

In `CHANGELOG.md`, under the `[Unreleased]` heading (create `### Changed` / `### Added` subsections if the section is empty), add:

```markdown
### Changed
- Redesigned the app shell: the sidebar is now collapsible (full ↔ icon rail with hover tooltips), its collapse state persists across launches, and the empty gap above the logo is gone. New "Coin S" brand mark and regenerated app icons.
- The top-bar **Add** button now creates a transaction directly; **adding an account moved to the Accounts screen** (an "Add account" button there).
- Removed the account-count row from the sidebar net-worth panel.
```

- [ ] **Step 3: Verify the build still passes**

Run: `npm run build`
Expected: PASS (docs-only, but confirm nothing else regressed).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: shell layout redesign — CLAUDE.md conventions + changelog"
```

---

## Final verification

- [ ] **Full build + tests**

Run: `npm run build && npm test`
Expected: both PASS.

- [ ] **Desktop manual pass (`npm run tauri dev`)**

Verify in the real window:
- New Coin S app icon in the dock; brand mark in the sidebar sits near the top with no empty gap, and the macOS traffic lights do not overlap it or the collapse chevron. If overlap occurs at the 28px drag region, bump it up a few px in `src/components/Sidebar.tsx` and document the final value.
- Collapse/expand works; window remains draggable from the sidebar header and the top bar in both states.
- Top-bar Add → AddTransaction; Accounts screen → Add account → AddAccount.

---

## Self-review notes (author)

- **Spec coverage:** collapsible sidebar (T3–T4, T6) · localStorage persistence (T6) · rail tooltips + net-worth hidden when collapsed (T4) · section-header→divider in rail (T4) · Transaction-only Add (T5–T6) · account creation on Accounts screen + empty-state copy (T7) · Coin S in-app mark (T2, T4) · OS icon regeneration (T8) · gap fix 46→28 (T4) · net-worth "Accounts" row removed (T4) · Sidebar/TopBar extraction + `src/nav.ts` (T1, T4, T5, T6) · no backend changes (none touched) · docs (T9). All covered.
- **Type consistency:** `ScreenId` sourced from `src/nav.ts` everywhere; `Sidebar` props (`onToggle`, `summary`, `navCount`, `mode`, `onToggleTheme`) match the `App` call site in T6; `TopBar` props (`title`, `sub`, `isDashboard`, `onShiftMonth`, `onAddTransaction`) match T6; `BrandMark({size,color,style})` matches its use in T4. `afterMutation` (async) is wrapped with `void` where passed to the `() => void` `onDone`.
- **Placeholders:** none — every step carries full code/commands.
