// App shell: macOS-style sidebar + toolbar, screen router, month navigation,
// theme toggle, and the Add menu. Owns the app-data store (accounts +
// categories) and refreshes screens via a version counter.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme, useThemeMode } from "./theme/ThemeProvider";
import { hexA } from "./theme/tokens";
import { useToast } from "./components/Toast";
import { Icon, type IconName } from "./components/Icon";
import { Btn } from "./components/ui";
import { AppDataCtx } from "./store";
import type { Account, Category } from "./types";
import { client } from "./client";
import { currentMonth, fmtMonth, shiftMonth } from "./lib/format";
import { useUpdater } from "./lib/updater";
import { Dashboard } from "./screens/Dashboard";
import { Accounts } from "./screens/Accounts";
import { Transactions } from "./screens/Transactions";
import { Settings } from "./screens/Settings";
import { Categories } from "./screens/Categories";
import { AddTransaction } from "./modals/AddTransaction";
import { AddAccount } from "./modals/AddAccount";

type ScreenId = "dashboard" | "accounts" | "transactions" | "categories" | "settings";
const NAV: { id: ScreenId; label: string; icon: IconName; sub: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "home", sub: "Your money at a glance" },
  { id: "accounts", label: "Accounts", icon: "wallet", sub: "All balances in one place" },
  { id: "transactions", label: "Transactions", icon: "list", sub: "Every ringgit in and out" },
  { id: "categories", label: "Categories", icon: "filter", sub: "Income, expense & transfer labels" },
  { id: "settings", label: "Settings", icon: "sliders", sub: "Preferences and about" },
];

export default function App() {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();
  const { notify } = useToast();
  const updater = useUpdater();
  const { checkForUpdates, desktop: updaterDesktop, state: updateState } = updater;
  const [active, setActive] = useState<ScreenId>("dashboard");
  const [month, setMonth] = useState(currentMonth());

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
  const [addOpen, setAddOpen] = useState(false);
  const [showTxn, setShowTxn] = useState(false);
  const [showAcct, setShowAcct] = useState(false);
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
  const go = (id: string) => { setActive(id as ScreenId); if (scroller.current) scroller.current.scrollTop = 0; };

  return (
    <AppDataCtx.Provider value={data}>
      <div className="sens" style={{ position: "fixed", inset: 0, display: "flex", background: t.bg, color: t.text, fontFamily: t.font }}>
        {/* sidebar */}
        <div style={{ width: 220, flexShrink: 0, background: t.sidebar, display: "flex", flexDirection: "column", borderRight: `0.5px solid ${t.border}` }}>
          <div data-tauri-drag-region style={{ height: 46, display: "flex", alignItems: "center", padding: "0 16px", flexShrink: 0 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 16px 16px" }}>
            <div style={{ width: 27, height: 27, borderRadius: 8, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${hexA(t.accent, 0.5)}` }}>
              <Icon name="sparkle" size={16} color={t.onAccent} stroke={2} />
            </div>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.3 }}>Sens</span>
          </div>
          <div style={{ padding: "0 10px", display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
            {NAV.map((it) => {
              const on = it.id === active;
              return (
                <div key={it.id} className="sens-nav" onClick={() => go(it.id)}
                  style={{ display: "flex", alignItems: "center", gap: 11, height: 34, padding: "0 11px", borderRadius: 8,
                    backgroundColor: on ? t.accentSoft : undefined, color: on ? t.text : t.dim, fontWeight: on ? 600 : 500, fontSize: 13.5 }}>
                  <Icon name={it.icon} size={17} color={on ? t.accent : t.dim} stroke={on ? 2 : 1.7} />
                  <span>{it.label}</span>
                </div>
              );
            })}
          </div>
          <div style={{ padding: 10, borderTop: `0.5px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="sens-nav" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 9, flex: 1 }}>
              <Icon name="wallet" size={16} color={t.dim} />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Personal</span>
            </div>
            <button className="sens-icon-btn" title="Toggle theme" onClick={toggle} style={{ width: 30, height: 30, color: t.dim }}>
              <Icon name={mode === "dark" ? "sun" : "moon"} size={16} />
            </button>
          </div>
        </div>

        {/* main */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div data-tauri-drag-region style={{ height: 60, flexShrink: 0, display: "flex", alignItems: "center", gap: 14, padding: "0 24px", borderBottom: `0.5px solid ${t.divider}` }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1.1 }}>{nav.label}</div>
              <div style={{ fontSize: 12, color: t.faint, marginTop: 1 }}>{nav.sub}</div>
            </div>
            <div style={{ flex: 1 }} />
            {active === "dashboard" && (
              <div style={{ display: "flex", alignItems: "center", gap: 2, background: t.panel, borderRadius: 8, border: `0.5px solid ${t.border}`, padding: 2 }}>
                <button className="sens-icon-btn" onClick={() => handleSetMonth((m) => shiftMonth(m, -1))} style={{ width: 28, height: 26, color: t.dim }}><Icon name="chevronLeft" size={15} /></button>
                <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 110, textAlign: "center" }}>{fmtMonth(month)}</span>
                <button className="sens-icon-btn" onClick={() => handleSetMonth((m) => shiftMonth(m, 1))} style={{ width: 28, height: 26, color: t.dim }}><Icon name="chevronRight" size={15} /></button>
              </div>
            )}
            <div style={{ position: "relative" }}>
              <Btn icon="plus" onClick={() => setAddOpen((o) => !o)}>Add</Btn>
              {addOpen && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 60 }} onClick={() => setAddOpen(false)} />
                  <div className="sens-pop" style={{ position: "absolute", right: 0, top: 40, zIndex: 61, width: 180, background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 11, padding: 5, boxShadow: "0 20px 50px rgba(0,0,0,0.4)" }}>
                    {[{ label: "Transaction", icon: "list" as IconName, fn: () => setShowTxn(true) }, { label: "Account", icon: "wallet" as IconName, fn: () => setShowAcct(true) }].map((o) => (
                      <button key={o.label} className="sens-btn sens-btn-ghost" onClick={() => { setAddOpen(false); o.fn(); }}
                        style={{ width: "100%", justifyContent: "flex-start", gap: 9, height: 34, padding: "0 10px", borderRadius: 7, fontSize: 13, fontWeight: 500, color: t.text }}>
                        <Icon name={o.icon} size={16} color={t.dim} /> {o.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div ref={scroller} style={{ flex: 1, overflow: "auto", padding: 24 }}>
            {active === "dashboard" && <Dashboard month={month} go={go} />}
            {active === "accounts" && <Accounts />}
            {active === "transactions" && <Transactions />}
            {active === "categories" && <Categories />}
            {active === "settings" && <Settings updater={updater} />}
          </div>
        </div>

        {showTxn && <AddTransaction accounts={accounts} categories={categories} onClose={() => setShowTxn(false)} onDone={() => { setShowTxn(false); reload(); }} />}
        {showAcct && <AddAccount onClose={() => setShowAcct(false)} onDone={() => { setShowAcct(false); reload(); }} />}
      </div>
    </AppDataCtx.Provider>
  );
}
