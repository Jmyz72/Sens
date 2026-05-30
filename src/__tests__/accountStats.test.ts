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
    expect(nw.series[0]).toBe(6000); // window-start net worth, before the in-window income
  });
});

describe("periodFromDate", () => {
  it("maps All to an empty lower bound", () => {
    expect(periodFromDate("All", "2026-05-30")).toBe("");
  });
  it("maps 3M to three months earlier", () => {
    expect(periodFromDate("3M", "2026-05-15")).toBe("2026-02-15");
  });
  it("clamps the day when the target month is shorter", () => {
    expect(periodFromDate("1M", "2026-03-31")).toBe("2026-02-28");
  });
});
