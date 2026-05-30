# Accounts Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Accounts screen with richer per-account insight (sparklines, monthly change, stats), a stronger net-worth header, and a deeper expanded panel — all computed on the frontend from existing data.

**Architecture:** A new pure module `src/lib/accountStats.ts` derives every stat/series from the transactions we already fetch; a new presentational `src/components/Sparkline.tsx` renders them. `Accounts.tsx` is rewritten to bulk-fetch all transactions once, compute per-account stats, and render dense rows + header + expanded panel. A small deep-link (`go(id, {accountId})`) carries an account filter into the Transactions screen. **No Rust, command, or `mock.ts` changes.**

**Tech Stack:** React 19 + TypeScript (strict), Vitest, existing theme tokens + `ui.tsx` atoms.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/accountStats.ts` | **new** — pure derived-stat + balance-series functions (the only place new math lives) |
| `src/__tests__/accountStats.test.ts` | **new** — unit tests for the stats module |
| `src/components/Sparkline.tsx` | **new** — reusable SVG sparkline/area + pure `sparkPath` geometry |
| `src/__tests__/sparkline.test.ts` | **new** — unit tests for `sparkPath` |
| `src/screens/Accounts.tsx` | **rewrite** — header, dense rows, expanded panel, period tabs, bulk fetch, `go` prop |
| `src/screens/Transactions.tsx` | **edit** — `initialAccountId` prop + clearable account filter |
| `src/App.tsx` | **edit** — `go(id, {accountId})`, store filter, wire props |

Conventions to honor: integer MYR cents end-to-end (format only at the edge via `src/lib/format.ts`); never hardcode colors — use `useTheme()` tokens; balance math reuses `signedFor` from `src/lib/kinds.ts`; the uniform sign rule (green when `balanceCents` moved up — which correctly makes *debt shrinking* green for `owe` accounts).

---

## Task 1: Pure stats module `accountStats.ts`

**Files:**
- Create: `src/lib/accountStats.ts`
- Test: `src/__tests__/accountStats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/accountStats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Account, Transaction, TransactionKind } from "../types";
import {
  accountTxns, txnDelta, balanceSeries, computeAccountStats, netWorthStats, periodFromDate,
} from "../lib/accountStats";

function acct(p: Partial<Account> & { id: string }): Account {
  return {
    id: p.id, templateKey: null, name: p.name ?? p.id, accountType: p.accountType ?? "fund",
    group: p.group ?? "own", subtype: p.subtype ?? "cash", openingBalanceCents: p.openingBalanceCents ?? 0,
    currency: "MYR", isArchived: p.isArchived ?? false, createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00", balanceCents: p.balanceCents ?? 0,
  };
}
let seq = 0;
function tx(kind: TransactionKind, accountId: string, amountCents: number, date: string, toAccountId: string | null = null): Transaction {
  seq += 1;
  return {
    id: `t${seq}`, kind, accountId, toAccountId, categoryId: null, amountCents,
    description: null, transactionDate: date, createdAt: `${date}T00:00:0${seq % 10}`, updatedAt: `${date}T00:00:00`,
  };
}

describe("txnDelta", () => {
  it("signs income/expense and both transfer legs by account perspective", () => {
    expect(txnDelta(tx("income", "a", 5000, "2026-05-01"), "a")).toBe(5000);
    expect(txnDelta(tx("expense", "a", 2000, "2026-05-01"), "a")).toBe(-2000);
    const xfer = tx("transfer", "a", 3000, "2026-05-01", "b");
    expect(txnDelta(xfer, "a")).toBe(-3000); // source
    expect(txnDelta(xfer, "b")).toBe(3000);  // destination
  });
  it("treats adjustment as already-signed", () => {
    expect(txnDelta(tx("adjustment", "a", -1500, "2026-05-01"), "a")).toBe(-1500);
  });
});

describe("computeAccountStats (own account)", () => {
  const a = acct({ id: "a1", openingBalanceCents: 10000 });
  const all = [tx("income", "a1", 5000, "2026-05-10"), tx("expense", "a1", 2000, "2026-05-20")];
  const s = computeAccountStats(a, all, "2026-05-30");

  it("computes current balance and month change", () => {
    expect(s.currentBalanceCents).toBe(13000);
    expect(s.monthChangeCents).toBe(3000);
  });
  it("splits in/out this month and counts txns", () => {
    expect(s.inThisMonthCents).toBe(5000);
    expect(s.outThisMonthCents).toBe(2000);
    expect(s.txnCount).toBe(2);
    expect(s.lastActivityDate).toBe("2026-05-20");
  });
  it("averages monthly outflow over active months", () => {
    expect(s.avgMonthlyOutCents).toBe(2000); // one active month
  });
});

describe("computeAccountStats (owe account — debt shrinking is positive)", () => {
  const a = acct({ id: "d1", group: "owe", accountType: "credit", subtype: "credit-card", openingBalanceCents: -50000 });
  const s = computeAccountStats(a, [tx("adjustment", "d1", 10000, "2026-05-15")], "2026-05-30");
  it("month change is positive when debt is paid down", () => {
    expect(s.currentBalanceCents).toBe(-40000);
    expect(s.monthChangeCents).toBe(10000);
  });
});

describe("computeAccountStats (zero transactions)", () => {
  const s = computeAccountStats(acct({ id: "z", openingBalanceCents: 7000 }), [], "2026-05-30");
  it("is well-defined with no activity", () => {
    expect(s.txnCount).toBe(0);
    expect(s.lastActivityDate).toBeNull();
    expect(s.monthChangeCents).toBe(0);
    expect(s.avgMonthlyOutCents).toBe(0);
    expect(s.sparkline).toEqual([7000, 7000]);
  });
});

describe("accountTxns + transfers across accounts", () => {
  const all = [tx("transfer", "a1", 3000, "2026-05-10", "a2")];
  it("includes a transfer for both source and destination", () => {
    expect(accountTxns(all, "a1")).toHaveLength(1);
    expect(accountTxns(all, "a2")).toHaveLength(1);
  });
});

describe("balanceSeries", () => {
  const a = acct({ id: "a1", openingBalanceCents: 0 });
  const all = Array.from({ length: 100 }, (_, i) =>
    tx("income", "a1", 100, `2026-05-${String((i % 28) + 1).padStart(2, "0")}`));
  it("downsamples but preserves first and last", () => {
    const series = balanceSeries(a, all, "", 48);
    expect(series.length).toBeLessThanOrEqual(48);
    expect(series[0]).toBe(0);                 // window-start baseline (before first txn)
    expect(series[series.length - 1]).toBe(10000); // 100 × 100c
  });
});

describe("netWorthStats", () => {
  const accounts = [
    acct({ id: "a1", openingBalanceCents: 10000 }),
    acct({ id: "d1", group: "owe", openingBalanceCents: -4000 }),
    acct({ id: "arc", openingBalanceCents: 99999, isArchived: true }),
  ];
  const all = [tx("income", "a1", 2000, "2026-05-12")];
  const nw = netWorthStats(accounts, all, "2026-05-30");
  it("sums active accounts and reports the month delta, excluding archived", () => {
    expect(nw.deltaCents).toBe(2000);
    expect(nw.pct).toBeCloseTo(2000 / 6000, 5); // start-of-month net worth = 10000-4000
    expect(nw.series[nw.series.length - 1]).toBe(8000); // 12000 - 4000
  });
});

describe("periodFromDate", () => {
  it("maps All to an empty lower bound", () => {
    expect(periodFromDate("All", "2026-05-30")).toBe("");
  });
  it("maps 3M to three months earlier", () => {
    expect(periodFromDate("3M", "2026-05-15")).toBe("2026-02-15");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/accountStats.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/accountStats"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/accountStats.ts`:

```ts
// Pure derived analytics for the Accounts screen. The only place that turns an
// account + its transactions into the stats/series the UI renders. Balance math
// reuses signedFor from kinds.ts; nothing here touches the client or the DOM.
//
// Sign convention is uniform for own AND owe accounts: a value is "good" (green)
// when balanceCents goes UP. For owe accounts balanceCents is negative, so debt
// shrinking (e.g. -50000 → -40000) is an increase — correctly positive.

import type { Account, Transaction, TransactionKind } from "../types";
import { signedFor } from "./kinds";

export interface AccountStats {
  txnCount: number;
  lastActivityDate: string | null;
  currentBalanceCents: number;
  monthChangeCents: number;
  inThisMonthCents: number;
  outThisMonthCents: number; // positive magnitude
  avgMonthlyOutCents: number;
  sparkline: number[]; // ~3-month balance series for the collapsed row
}

export type ChartPeriod = "1M" | "3M" | "6M" | "1Y" | "All";

/** Per-account signed delta for one transaction (handles both transfer legs). */
export function txnDelta(tx: Transaction, accountId: string): number {
  return signedFor(tx.kind, tx.amountCents, tx.toAccountId === accountId);
}

/** Every transaction that touches an account (as source or destination). */
export function accountTxns(all: Transaction[], accountId: string): Transaction[] {
  return all.filter((tx) => tx.accountId === accountId || tx.toAccountId === accountId);
}

function sortByDate(txns: Transaction[]): Transaction[] {
  return [...txns].sort((a, b) => {
    const ka = a.transactionDate + "\x00" + a.createdAt;
    const kb = b.transactionDate + "\x00" + b.createdAt;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function downsample(a: number[], max: number): number[] {
  if (a.length <= max) return a;
  const out: number[] = [];
  const step = (a.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(a[Math.round(i * step)]);
  return out;
}

/** Subtract n calendar months from a YYYY-MM-DD date, in local time. */
function monthsAgoISO(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(y, m - 1 - n, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Inclusive count of calendar months between two YYYY-MM-DD dates (min 1). */
function monthSpan(fromISO: string, toISO: string): number {
  const [fy, fm] = fromISO.split("-").map(Number);
  const [ty, tm] = toISO.split("-").map(Number);
  return Math.max(1, ty * 12 + tm - (fy * 12 + fm) + 1);
}

export function periodFromDate(period: ChartPeriod, today: string): string {
  switch (period) {
    case "1M": return monthsAgoISO(today, 1);
    case "3M": return monthsAgoISO(today, 3);
    case "6M": return monthsAgoISO(today, 6);
    case "1Y": return monthsAgoISO(today, 12);
    case "All": return "";
  }
}

/**
 * Balance values across [fromDate, ∞), suitable for a sparkline: seeded at the
 * balance as of fromDate, then one value after each in-window transaction.
 * `fromDate === ""` means "from the beginning". X-axis is index-based.
 */
export function balanceSeries(account: Account, txns: Transaction[], fromDate: string, maxPoints = 48): number[] {
  const sorted = sortByDate(txns);
  let bal = account.openingBalanceCents;
  const series: number[] = [];
  let seeded = false;
  for (const tx of sorted) {
    const d = txnDelta(tx, account.id);
    bal += d;
    if (tx.transactionDate >= fromDate) {
      if (!seeded) { series.push(bal - d); seeded = true; } // window-start baseline
      series.push(bal);
    }
  }
  if (series.length === 0) return [bal, bal]; // flat line at current balance
  return downsample(series, maxPoints);
}

export function computeAccountStats(account: Account, allTxns: Transaction[], today: string): AccountStats {
  const txns = accountTxns(allTxns, account.id);
  const sorted = sortByDate(txns);
  const monthStart = today.slice(0, 7) + "-01";

  let balance = account.openingBalanceCents;
  let balanceAtMonthStart = account.openingBalanceCents;
  let inThisMonth = 0, outThisMonth = 0, totalOut = 0;
  let lastActivityDate: string | null = null;

  for (const tx of sorted) {
    const d = txnDelta(tx, account.id);
    if (tx.transactionDate < monthStart) balanceAtMonthStart += d;
    else if (tx.transactionDate <= today) {
      if (d > 0) inThisMonth += d; else outThisMonth += -d;
    }
    if (d < 0) totalOut += -d;
    balance += d;
    lastActivityDate = tx.transactionDate; // ascending → last wins
  }

  const monthsActive = sorted.length === 0 ? 1 : monthSpan(sorted[0].transactionDate, today);
  return {
    txnCount: txns.length,
    lastActivityDate,
    currentBalanceCents: balance,
    monthChangeCents: balance - balanceAtMonthStart,
    inThisMonthCents: inThisMonth,
    outThisMonthCents: outThisMonth,
    avgMonthlyOutCents: Math.round(totalOut / monthsActive),
    sparkline: balanceSeries(account, txns, monthsAgoISO(today, 3), 48),
  };
}

export interface NetWorthStats {
  deltaCents: number;
  pct: number | null; // delta / |netWorth at start of month|; null when start is 0
  series: number[]; // ~6-month net-worth series for the header sparkline
}

export function netWorthStats(accounts: Account[], allTxns: Transaction[], today: string): NetWorthStats {
  const active = accounts.filter((a) => !a.isArchived);
  const monthStart = today.slice(0, 7) + "-01";
  let now = 0, atMonthStart = 0;
  for (const a of active) {
    let bal = a.openingBalanceCents, balMS = a.openingBalanceCents;
    for (const tx of accountTxns(allTxns, a.id)) {
      const d = txnDelta(tx, a.id);
      bal += d;
      if (tx.transactionDate < monthStart) balMS += d;
    }
    now += bal; atMonthStart += balMS;
  }
  const deltaCents = now - atMonthStart;
  return {
    deltaCents,
    pct: atMonthStart === 0 ? null : deltaCents / Math.abs(atMonthStart),
    series: netWorthSeries(active, allTxns, monthsAgoISO(today, 6)),
  };
}

function netWorthSeries(active: Account[], allTxns: Transaction[], fromDate: string, maxPoints = 48): number[] {
  const bal = new Map<string, number>();
  for (const a of active) {
    let b = a.openingBalanceCents;
    for (const tx of accountTxns(allTxns, a.id)) {
      if (tx.transactionDate < fromDate) b += txnDelta(tx, a.id);
    }
    bal.set(a.id, b);
  }
  const total = () => { let s = 0; for (const v of bal.values()) s += v; return s; };
  const ids = new Set(active.map((a) => a.id));
  const events = sortByDate(
    allTxns.filter((tx) => tx.transactionDate >= fromDate && (ids.has(tx.accountId) || (tx.toAccountId !== null && ids.has(tx.toAccountId)))),
  );
  const series = [total()];
  for (const tx of events) {
    if (ids.has(tx.accountId)) bal.set(tx.accountId, bal.get(tx.accountId)! + txnDelta(tx, tx.accountId));
    if (tx.toAccountId !== null && ids.has(tx.toAccountId)) bal.set(tx.toAccountId, bal.get(tx.toAccountId)! + txnDelta(tx, tx.toAccountId));
    series.push(total());
  }
  return downsample(series, maxPoints);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/accountStats.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/accountStats.ts src/__tests__/accountStats.test.ts
git commit -m "feat(accounts): pure derived-stat + balance-series module"
```

---

## Task 2: Reusable `Sparkline` component

**Files:**
- Create: `src/components/Sparkline.tsx`
- Test: `src/__tests__/sparkline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sparkline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sparkPath } from "../components/Sparkline";

describe("sparkPath", () => {
  it("returns empty path for no points", () => {
    expect(sparkPath([], 64, 28)).toEqual({ line: "", area: "" });
  });
  it("maps a rising series to a line whose last y is above (smaller than) the first", () => {
    const { line, area } = sparkPath([0, 10], 64, 28);
    const ys = [...line.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[1]).toBeLessThan(ys[0]); // higher value → smaller y (SVG top-down)
    expect(area.endsWith("Z")).toBe(true);
  });
  it("draws a flat series through the vertical middle", () => {
    const { line } = sparkPath([5, 5, 5], 60, 30);
    const ys = [...line.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    ys.forEach((y) => expect(y).toBeCloseTo(15, 1));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sparkline.test.ts`
Expected: FAIL — `Failed to resolve import "../components/Sparkline"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/Sparkline.tsx`:

```tsx
// Tiny presentational SVG sparkline / area chart. Pure geometry lives in
// sparkPath so it is unit-testable; the component is a thin token-driven wrapper.
// Colors come from the caller (theme tokens) — no hardcoded hex.

import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";

export function sparkPath(points: number[], width: number, height: number, pad = 1): { line: string; area: string } {
  if (points.length === 0) return { line: "", area: "" };
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const n = points.length;
  const xs = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - 2 * pad));
  const ys = (v: number) => pad + (1 - (v - min) / span) * (height - 2 * pad);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sparkline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sparkline.tsx src/__tests__/sparkline.test.ts
git commit -m "feat(accounts): reusable Sparkline component"
```

---

## Task 3: Rewrite the Accounts screen

This task is presentational; it is verified by the build gate + test suite + a manual check (the codebase tests logic in `lib/`, not screens). All new logic was already covered in Task 1.

**Files:**
- Modify (full rewrite): `src/screens/Accounts.tsx`

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/screens/Accounts.tsx` with:

```tsx
// Accounts: net-worth header (with monthly delta + trend sparkline), accounts
// grouped by type with dense insight rows (sparkline + monthly change + stats),
// each expandable into a period-selectable balance chart, In/Out/Net tiles,
// actions, and recent activity. All stats are computed on the frontend from a
// one-time bulk fetch of transactions (src/lib/accountStats.ts). Archived
// accounts are excluded from net worth.

import { useEffect, useMemo, useState } from "react";
import type { Account, AccountTypeName, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import type { Theme } from "../theme/tokens";
import { Btn, Card, Empty, GlyphTile, Money } from "../components/ui";
import { Icon } from "../components/Icon";
import { TxnRow } from "../components/TxnRow";
import { Sparkline } from "../components/Sparkline";
import { client } from "../client";
import { useAppData } from "../store";
import { SetBalance } from "../modals/SetBalance";
import { EditAccount } from "../modals/EditAccount";
import { accountTone } from "../lib/brand";
import { balanceDisplay, toneColor, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
import { useToast } from "../components/Toast";
import { computeRunningBalances } from "../lib/kinds";
import { fmtDate, fmtMoney, todayISO } from "../lib/format";
import {
  accountTxns, balanceSeries, computeAccountStats, netWorthStats, periodFromDate,
  type AccountStats, type ChartPeriod,
} from "../lib/accountStats";

const ACTIVITY_DISPLAY_LIMIT = 8;
const TXN_FETCH_LIMIT = 5000;
const PERIODS: ChartPeriod[] = ["1M", "3M", "6M", "1Y", "All"];

function Delta({ cents, t, size = 11 }: { cents: number; t: Theme; size?: number }) {
  if (cents === 0) return <span style={{ fontSize: size, color: t.faint, fontFamily: t.mono }}>—</span>;
  const up = cents > 0;
  return (
    <span style={{ fontSize: size, color: up ? t.income : t.negative, fontFamily: t.mono, whiteSpace: "nowrap" }}>
      {up ? "▲" : "▼"} {fmtMoney(Math.abs(cents))}
    </span>
  );
}

export function Accounts({ go }: { go: (id: string, opts?: { accountId?: string }) => void }) {
  const t = useTheme();
  const { categories, reload, version } = useAppData();
  const { notify } = useToast();
  const today = todayISO();
  const [showArchived, setShowArchived] = useState(false);
  const [all, setAll] = useState<Account[]>([]);
  const [allTxns, setAllTxns] = useState<Transaction[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [period, setPeriod] = useState<ChartPeriod>("3M");
  const [correcting, setCorrecting] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);

  useEffect(() => { client.listAccounts(true).then(setAll).catch(() => {}); }, [version]);
  useEffect(() => {
    client.listTransactions({ limit: TXN_FETCH_LIMIT }).then(setAllTxns)
      .catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to load activity", "error"));
  }, [version, notify]);

  const stats = useMemo(() => {
    const m = new Map<string, AccountStats>();
    for (const a of all) m.set(a.id, computeAccountStats(a, allTxns, today));
    return m;
  }, [all, allTxns, today]);
  const nw = useMemo(() => netWorthStats(all, allTxns, today), [all, allTxns, today]);

  const visible = all.filter((a) => showArchived || !a.isArchived);
  const active = all.filter((a) => !a.isArchived);
  const assets = active.filter((a) => a.group === "own").reduce((s, a) => s + a.balanceCents, 0);
  const liabilities = active.filter((a) => a.group === "owe").reduce((s, a) => s + a.balanceCents, 0);
  const netWorth = assets + liabilities;

  const groups = new Map<AccountTypeName, Account[]>();
  visible.forEach((a) => { if (!groups.has(a.accountType)) groups.set(a.accountType, []); groups.get(a.accountType)!.push(a); });
  const orderedGroups = TYPE_ORDER.filter((ty) => groups.has(ty)).map((ty) => [ty, groups.get(ty)!] as const);

  function toggle(id: string) {
    setOpen((cur) => (cur === id ? null : id));
    setPeriod("3M");
  }
  const afterMutation = async () => { await reload(); };

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 880 }}>
      {/* ===== Net-worth header ===== */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: t.dim, marginBottom: 5 }}>Net worth</div>
            <Money cents={netWorth} size={28} weight={700} color={netWorth < 0 ? t.negative : t.text} />
            <div style={{ fontSize: 12, color: t.dim, marginTop: 6 }}>
              <Delta cents={nw.deltaCents} t={t} size={12} />
              {nw.pct !== null && <span style={{ color: t.faint }}> ({(nw.pct * 100).toFixed(1)}%)</span>}
              <span style={{ color: t.faint }}> this month</span>
            </div>
            <div style={{ fontSize: 12, color: t.dim, marginTop: 5 }}>
              Assets <Money cents={assets} size={12} color={t.dim} /> &nbsp;·&nbsp; Owe <Money cents={Math.abs(liabilities)} size={12} color={t.dim} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <Sparkline points={nw.series} color={t.accent} fill width={120} height={46} />
            <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
          </div>
        </div>
      </Card>

      {visible.length === 0 && <Card><Empty icon="wallet" title="No accounts yet" hint="Create one from the Add menu." /></Card>}

      {/* ===== Grouped accounts ===== */}
      {orderedGroups.map(([ty, accs]) => {
        const subtotal = accs.filter((a) => !a.isArchived).reduce((s, a) => s + a.balanceCents, 0);
        return (
          <div key={ty}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px 10px" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>{TYPE_LABEL[ty]}</span>
              <Money cents={subtotal} size={13} color={subtotal < 0 ? t.negative : t.dim} />
            </div>
            <Card pad={0} style={{ overflow: "hidden" }}>
              {accs.map((a, i) => {
                const isOpen = open === a.id;
                const st = stats.get(a.id);
                const txns = accountTxns(allTxns, a.id);
                const v = balanceDisplay(a.group, a.balanceCents);
                const sparkPoints = st?.sparkline ?? [];
                const trendUp = sparkPoints.length < 2 || sparkPoints[sparkPoints.length - 1] >= sparkPoints[0];
                const trendColor = trendUp ? t.income : t.negative;
                return (
                  <div key={a.id} style={{ borderTop: i ? `0.5px solid ${t.divider}` : "none", opacity: a.isArchived ? 0.55 : 1 }}>
                    {/* collapsed dense row */}
                    <div className="sens-row click" onClick={() => toggle(a.id)} style={{ display: "flex", alignItems: "center", gap: 13, padding: "0 18px", minHeight: 78 }}>
                      <GlyphTile tone={accountTone({ templateKey: a.templateKey, fallbackSeed: a.id }, t.accent)} size={36} emoji={a.name[0]} radius={10} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                          {a.name}
                          {a.isArchived && <span style={{ fontSize: 10, fontWeight: 700, color: t.faint, border: `0.5px solid ${t.border}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>Archived</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: t.faint }}>
                          <span style={{ textTransform: "capitalize" }}>{a.subtype.replace(/-/g, " ")}</span>
                          {st?.lastActivityDate && <span> · last activity {fmtDate(st.lastActivityDate).toLowerCase()}</span>}
                        </div>
                        {st && st.txnCount > 0 && (
                          <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                            <span style={{ fontSize: 10, color: t.dim, background: t.panel2, borderRadius: 4, padding: "1px 5px", fontFamily: t.mono }}>{st.txnCount} txns</span>
                            <span style={{ fontSize: 10, color: t.dim, background: t.panel2, borderRadius: 4, padding: "1px 5px", fontFamily: t.mono }}>avg {fmtMoney(st.avgMonthlyOutCents)}/mo</span>
                          </div>
                        )}
                      </div>
                      {sparkPoints.length >= 2 && <Sparkline points={sparkPoints} color={trendColor} fill width={64} height={28} />}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        {v.label && <span style={{ fontSize: 10, color: t.faint }}>{v.label}</span>}
                        <Money cents={v.magnitude} size={15} color={toneColor(v.tone, t)} />
                        {st && <Delta cents={st.monthChangeCents} t={t} />}
                      </div>
                      <Icon name="chevronDown" size={15} color={t.faint} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                    </div>

                    {/* expanded panel */}
                    {isOpen && (() => {
                      const running = txns.length > 0 ? computeRunningBalances(txns, a.id, a.openingBalanceCents) : new Map<string, number>();
                      const recent = [...txns].sort((x, y) => (x.transactionDate < y.transactionDate ? 1 : x.transactionDate > y.transactionDate ? -1 : 0)).slice(0, ACTIVITY_DISPLAY_LIMIT);
                      const hidden = txns.length - recent.length;
                      const chart = balanceSeries(a, txns, periodFromDate(period, today), 64);
                      return (
                        <div className="sens-pop" style={{ background: t.panel2, padding: "12px 18px 16px" }}>
                          {/* period tabs */}
                          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                            {PERIODS.map((p) => (
                              <button key={p} onClick={() => setPeriod(p)} style={{
                                border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 6,
                                fontFamily: t.font, color: period === p ? t.accent : t.dim, background: period === p ? t.accentSoft : "transparent",
                              }}>{p}</button>
                            ))}
                          </div>
                          {/* balance chart */}
                          <div style={{ marginBottom: 12 }}>
                            <Sparkline points={chart} color={t.accent} fill width={820} height={72} />
                          </div>
                          {/* stat tiles */}
                          {st && (
                            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                              {([
                                ["In · this month", st.inThisMonthCents, t.income],
                                ["Out · this month", st.outThisMonthCents, t.negative],
                                ["Net", st.monthChangeCents, st.monthChangeCents >= 0 ? t.income : t.negative],
                              ] as const).map(([label, cents, color]) => (
                                <div key={label} style={{ flex: 1, background: t.panel3, borderRadius: 9, padding: "9px 11px" }}>
                                  <div style={{ fontSize: 10, color: t.faint, marginBottom: 3 }}>{label}</div>
                                  <Money cents={Math.abs(cents)} size={13} color={color} />
                                </div>
                              ))}
                            </div>
                          )}
                          {/* actions */}
                          <div style={{ display: "flex", gap: 8, padding: "0 0 12px" }}>
                            <Btn variant="outline" size="sm" icon="scale" onClick={() => setCorrecting(a)}>Correct balance</Btn>
                            <Btn variant="outline" size="sm" icon="pencil" onClick={() => setEditing(a)}>Edit</Btn>
                            {a.isArchived
                              ? <Btn variant="outline" size="sm" icon="restore" onClick={() => client.restoreAccount(a.id).then(afterMutation).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to restore account", "error"))}>Restore</Btn>
                              : <Btn variant="outline" size="sm" icon="archive" onClick={() => client.archiveAccount(a.id).then(afterMutation).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to archive account", "error"))}>Archive</Btn>}
                          </div>
                          {/* recent activity */}
                          <div style={{ fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 4 }}>Recent activity</div>
                          {txns.length === 0
                            ? <div style={{ fontSize: 12.5, color: t.faint, padding: "6px 0" }}>No transactions on this account yet.</div>
                            : recent.map((tx) => (
                                <TxnRow key={tx.id} tx={tx} accounts={all} categories={categories} perspectiveAccountId={a.id} balanceAfterCents={running.get(tx.id)} />
                              ))}
                          {hidden > 0 && (
                            <div className="sens-link" onClick={() => go("transactions", { accountId: a.id })} style={{ fontSize: 11.5, color: t.accent, paddingTop: 8, textAlign: "center", cursor: "pointer", fontWeight: 600 }}>
                              View all {txns.length} transactions →
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </Card>
          </div>
        );
      })}

      {correcting && <SetBalance account={correcting} hasTransactions={accountTxns(allTxns, correcting.id).length > 0 || correcting.balanceCents !== correcting.openingBalanceCents} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); afterMutation(); }} />}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); afterMutation(); }} />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: PASS — `tsc` clean (strict, `noUnusedLocals/Parameters`). The imports block deliberately does **not** import `hexA` (the rewrite never calls it); only `import type { Theme }` is pulled from `../theme/tokens`.

- [ ] **Step 3: Run the test suite**

Run: `npm test`
Expected: PASS — existing `accounts.test.ts` / `mock-accounts.test.ts` still green; new modules green.

- [ ] **Step 4: Manual smoke check (browser mock backend)**

Run: `npm run dev`, open the app, go to Accounts. Verify: net-worth header shows a sparkline + "▲/▼ … this month"; rows show a sparkline, `subtype · last activity …`, stat chips, and a monthly delta; expanding a row shows period tabs that change the chart, In/Out/Net tiles, actions, recent activity. (Note: `go` deep-link is wired in Task 5; "View all" becomes functional then.)

- [ ] **Step 5: Commit**

```bash
git add src/screens/Accounts.tsx
git commit -m "feat(accounts): rich header, dense insight rows, expanded chart panel"
```

---

## Task 4: Account filter in the Transactions screen

**Files:**
- Modify: `src/screens/Transactions.tsx`

- [ ] **Step 1: Add the `initialAccountId` prop and filter state**

In `src/screens/Transactions.tsx`, change the component signature and add state. Replace:

```tsx
export function Transactions() {
  const t = useTheme();
  const { accounts, categories, reload, version } = useAppData();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<TransactionKind>>(new Set());
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);

  useEffect(() => { client.listTransactions({ limit: 500 }).then(setTxns).catch(() => {}); }, [version]);
```

with:

```tsx
export function Transactions({ initialAccountId }: { initialAccountId?: string | null }) {
  const t = useTheme();
  const { accounts, categories, reload, version } = useAppData();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<TransactionKind>>(new Set());
  const [acctFilter, setAcctFilter] = useState<string | null>(initialAccountId ?? null);
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);

  useEffect(() => { client.listTransactions({ limit: 500 }).then(setTxns).catch(() => {}); }, [version]);
  useEffect(() => { setAcctFilter(initialAccountId ?? null); }, [initialAccountId]);
```

- [ ] **Step 2: Apply the account filter inside `filtered`**

In the `filtered` `useMemo`, add the account check as the first predicate and add `acctFilter` to the dependency array. Replace:

```tsx
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return txns.filter((tx) => {
      if (kinds.size && !kinds.has(tx.kind)) return false;
      if (!q) return true;
      const cat = categories.find((c) => c.id === tx.categoryId)?.name ?? "";
      return (tx.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || accountName(accounts, tx.accountId).toLowerCase().includes(q);
    });
  }, [txns, kinds, query, categories, accounts]);
```

with:

```tsx
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return txns.filter((tx) => {
      if (acctFilter && tx.accountId !== acctFilter && tx.toAccountId !== acctFilter) return false;
      if (kinds.size && !kinds.has(tx.kind)) return false;
      if (!q) return true;
      const cat = categories.find((c) => c.id === tx.categoryId)?.name ?? "";
      return (tx.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || accountName(accounts, tx.accountId).toLowerCase().includes(q);
    });
  }, [txns, kinds, query, categories, accounts, acctFilter]);
```

- [ ] **Step 3: Render a clearable account-filter chip**

In the kind-filter row, add an account chip. Replace:

```tsx
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {KIND_FILTERS.map((k) => <Pill key={k} on={kinds.has(k)} dot={kindColor(t, k)} onClick={() => toggleKind(k)}>{KIND_META[k].label}</Pill>)}
          {kinds.size > 0 && <Pill onClick={() => setKinds(new Set())}>Clear</Pill>}
        </div>
```

with:

```tsx
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {acctFilter && <Pill on onClick={() => setAcctFilter(null)}>Account: {accountName(accounts, acctFilter)} ✕</Pill>}
          {KIND_FILTERS.map((k) => <Pill key={k} on={kinds.has(k)} dot={kindColor(t, k)} onClick={() => toggleKind(k)}>{KIND_META[k].label}</Pill>)}
          {kinds.size > 0 && <Pill onClick={() => setKinds(new Set())}>Clear</Pill>}
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS. (`Transactions` now requires no props at the type level because `initialAccountId` is optional; App passes it in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/screens/Transactions.tsx
git commit -m "feat(transactions): optional account filter for deep-linking"
```

---

## Task 5: Wire the deep-link in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Extend `go` and add filter state**

In `src/App.tsx`, find the `go` definition (around line 98). Replace:

```tsx
  const go = (id: string) => { setActive(id as ScreenId); if (scroller.current) scroller.current.scrollTop = 0; };
```

with:

```tsx
  const go = (id: string, opts?: { accountId?: string }) => {
    setActive(id as ScreenId);
    setTxnAccountId(opts?.accountId ?? null);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
```

- [ ] **Step 2: Declare the filter state**

Next to the other `useState` hooks (near `const [showAcct, setShowAcct] = useState(false);`), add:

```tsx
  const [txnAccountId, setTxnAccountId] = useState<string | null>(null);
```

- [ ] **Step 3: Pass props to the screens**

In the render block, replace:

```tsx
            {active === "accounts" && <Accounts />}
            {active === "transactions" && <Transactions />}
```

with:

```tsx
            {active === "accounts" && <Accounts go={go} />}
            {active === "transactions" && <Transactions initialAccountId={txnAccountId} />}
```

- [ ] **Step 4: Typecheck + build + test**

Run: `npm run build && npm test`
Expected: PASS — `Accounts` now receives its required `go` prop; `Transactions` receives the optional filter.

- [ ] **Step 5: Manual smoke check of the full flow**

Run: `npm run dev`. On Accounts, expand an account with more than 8 transactions and click **"View all N transactions →"**. Expected: the Transactions screen opens with an "Account: <name> ✕" chip and only that account's transactions. Clicking the chip clears the filter; clicking the Transactions nav item also clears it.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): deep-link account filter from Accounts to Transactions"
```

---

## Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `npm run build && npm test`
Expected: both PASS, clean.

- [ ] **Step 2: Rust unchanged sanity (optional, fast)**

No backend was touched, but confirm nothing drifted:
Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: PASS (unchanged).

- [ ] **Step 3: Manual acceptance pass**

Run: `npm run dev` and confirm against the spec:
- Header: net worth + monthly delta (with %) + trend sparkline + Show-archived toggle.
- Rows: glyph, name, `subtype · last activity`, stat chips, filled balance sparkline (green up / red down — including a paid-down `owe` account trending green), balance + monthly delta.
- Expanded: period tabs (default 3M) change the chart; In/Out/Net tiles; Correct balance / Edit / Archive; recent activity; "View all" deep-links.
- Show archived reveals archived accounts (dimmed) and they stay excluded from net worth.

- [ ] **Step 4: Update CHANGELOG `[Unreleased]`**

Add a line under `[Unreleased]` in `CHANGELOG.md` (do not hand-edit version files):

```
- Redesigned the Accounts screen: net-worth trend + monthly change, per-account sparklines and stats, an expandable balance chart with period selector, and a deep link into filtered transactions.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for accounts screen redesign"
```

---

## Notes for the implementer

- **Bulk fetch, not per-account:** the screen now fetches all transactions once (`TXN_FETCH_LIMIT`) and derives everything; do not reintroduce per-account fetches on expand.
- **Sign rule is uniform:** never special-case `owe` for the delta/sparkline tone — `balanceCents` direction already encodes "good." The displayed *balance magnitude* still goes through `balanceDisplay` (Task 3 keeps this).
- **No `mock.ts` changes:** this redesign calls only existing client methods. If you find yourself editing `src/client/mock.ts` or any Rust file, stop — you've gone out of scope.
- **Determinism:** `computeAccountStats`/`netWorthStats` take `today` as a parameter so they stay pure and testable; the screen passes `todayISO()`.
```
