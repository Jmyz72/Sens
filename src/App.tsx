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
