// Pure derived analytics for the Accounts screen. The only place that turns an
// account + its transactions into the stats/series the UI renders. Balance math
// reuses signedFor from kinds.ts; nothing here touches the client or the DOM.
//
// Sign convention is uniform for own AND owe accounts: a value is "good" (green)
// when balanceCents goes UP. For owe accounts balanceCents is negative, so debt
// shrinking (e.g. -50000 → -40000) is an increase — correctly positive.

import type { Account, Transaction } from "../types";
import { signedFor, txnSortKey } from "./kinds";

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
    const ka = txnSortKey(a);
    const kb = txnSortKey(b);
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

/** Subtract n calendar months from a YYYY-MM-DD date, clamping the day to the
 *  target month's last valid day (so May 31 − 3mo = Feb 28, not Mar 3). */
function monthsAgoISO(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const lastDay = new Date(y, m - n, 0).getDate(); // day 0 of (target month + 1) = last day of target month
  const dt = new Date(y, m - 1 - n, Math.min(d, lastDay));
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

/**
 * Derive an account's stats. `allTxns` MUST be the complete, unfiltered
 * transaction history — balances are recomputed as openingBalance + Σ deltas,
 * so a windowed/paged slice would yield a wrong currentBalance/monthChange.
 * `today` is a YYYY-MM-DD string (injected for determinism/testability).
 */
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

/**
 * Net-worth delta + trend across non-archived accounts. Like computeAccountStats,
 * `allTxns` MUST be the complete transaction history (balances are recomputed).
 */
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
