import { describe, it, expect } from "vitest";
import { KIND_META, kindColor, signedFor, computeRunningBalances } from "../lib/kinds";
import { THEMES } from "../theme/tokens";
import type { Transaction } from "../types";

// ── signedFor ─────────────────────────────────────────────────────────────────

describe("signedFor", () => {
  it("income: returns amount as-is (positive)", () => {
    expect(signedFor("income", 5000)).toBe(5000);
  });

  it("income: returns amount as-is even for large values", () => {
    expect(signedFor("income", 100000)).toBe(100000);
  });

  it("expense: negates the amount", () => {
    expect(signedFor("expense", 5000)).toBe(-5000);
  });

  it("adjustment: returns amount unchanged (already signed; positive adjustment)", () => {
    expect(signedFor("adjustment", 1000)).toBe(1000);
  });

  it("adjustment: returns amount unchanged (negative adjustment)", () => {
    expect(signedFor("adjustment", -500)).toBe(-500);
  });

  it("transfer source (isDestination=false): negates the amount", () => {
    expect(signedFor("transfer", 10000, false)).toBe(-10000);
  });

  it("transfer source (default isDestination): negates the amount", () => {
    expect(signedFor("transfer", 10000)).toBe(-10000);
  });

  it("transfer destination (isDestination=true): returns amount as-is", () => {
    expect(signedFor("transfer", 10000, true)).toBe(10000);
  });
});

// ── kindColor ─────────────────────────────────────────────────────────────────

describe("kindColor with THEMES.dark", () => {
  it("income returns THEMES.dark.income", () => {
    expect(kindColor(THEMES.dark, "income")).toBe(THEMES.dark.income);
  });

  it("expense returns THEMES.dark.expense", () => {
    expect(kindColor(THEMES.dark, "expense")).toBe(THEMES.dark.expense);
  });

  it("transfer returns THEMES.dark.transfer", () => {
    expect(kindColor(THEMES.dark, "transfer")).toBe(THEMES.dark.transfer);
  });

  it("adjustment returns THEMES.dark.adjustment", () => {
    expect(kindColor(THEMES.dark, "adjustment")).toBe(THEMES.dark.adjustment);
  });
});

// ── KIND_META ─────────────────────────────────────────────────────────────────

describe("KIND_META", () => {
  const kinds = ["income", "expense", "transfer", "adjustment"] as const;

  it("has all four kinds", () => {
    for (const k of kinds) {
      expect(KIND_META).toHaveProperty(k);
    }
  });

  it("income has correct label, icon, colorKey, and sign", () => {
    expect(KIND_META.income.label).toBe("Income");
    expect(KIND_META.income.icon).toBe("in");
    expect(KIND_META.income.colorKey).toBe("income");
    expect(KIND_META.income.sign).toBe(1);
  });

  it("expense has correct label, icon, colorKey, and sign", () => {
    expect(KIND_META.expense.label).toBe("Expense");
    expect(KIND_META.expense.icon).toBe("out");
    expect(KIND_META.expense.colorKey).toBe("expense");
    expect(KIND_META.expense.sign).toBe(-1);
  });

  it("transfer has correct label, icon, colorKey, and sign", () => {
    expect(KIND_META.transfer.label).toBe("Transfer");
    expect(KIND_META.transfer.icon).toBe("swap");
    expect(KIND_META.transfer.colorKey).toBe("transfer");
    expect(KIND_META.transfer.sign).toBe(0);
  });

  it("adjustment has correct label, icon, colorKey, and sign", () => {
    expect(KIND_META.adjustment.label).toBe("Balance adjustment");
    expect(KIND_META.adjustment.icon).toBe("sliders");
    expect(KIND_META.adjustment.colorKey).toBe("adjustment");
    expect(KIND_META.adjustment.sign).toBe(0);
  });

  it("each entry has a label, icon, and colorKey", () => {
    for (const k of kinds) {
      const meta = KIND_META[k];
      expect(typeof meta.label).toBe("string");
      expect(typeof meta.icon).toBe("string");
      expect(typeof meta.colorKey).toBe("string");
    }
  });
});

// ── computeRunningBalances ────────────────────────────────────────────────────

const mkTx = (overrides: Partial<Transaction> & { id: string }): Transaction => ({
  kind: "expense",
  accountId: "acc1",
  toAccountId: null,
  categoryId: null,
  amountCents: 1000,
  description: null,
  transactionDate: "2026-01-01",
  transactionTime: null,
  excludedFromReporting: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

// An `opening` row that sorts first and seeds the starting balance. The running
// total now starts at 0, so the opening transaction carries the opening value.
const mkOpening = (amountCents: number, accountId = "acc1"): Transaction =>
  mkTx({
    id: "open", kind: "opening", accountId, categoryId: null, amountCents,
    description: "Opening balance", transactionDate: "2025-12-31",
    createdAt: "2025-12-31T00:00:00Z", updatedAt: "2025-12-31T00:00:00Z",
  });

describe("computeRunningBalances", () => {
  it("empty transaction list returns empty map", () => {
    const result = computeRunningBalances([], "acc1");
    expect(result.size).toBe(0);
  });

  it("single income transaction: balance = opening + amount", () => {
    const tx = mkTx({ id: "t1", kind: "income", amountCents: 5000, accountId: "acc1" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("open")).toBe(10000);
    expect(result.get("t1")).toBe(15000);
  });

  it("single expense transaction: balance = opening - amount", () => {
    const tx = mkTx({ id: "t1", kind: "expense", amountCents: 3000, accountId: "acc1" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("t1")).toBe(7000);
  });

  it("transfer as source: balance decreases", () => {
    const tx = mkTx({ id: "t1", kind: "transfer", amountCents: 2000, accountId: "acc1", toAccountId: "acc2" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("t1")).toBe(8000);
  });

  it("transfer as destination: balance increases", () => {
    const tx = mkTx({ id: "t1", kind: "transfer", amountCents: 2000, accountId: "acc2", toAccountId: "acc1" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("t1")).toBe(12000);
  });

  it("positive adjustment: balance increases", () => {
    const tx = mkTx({ id: "t1", kind: "adjustment", amountCents: 500, accountId: "acc1" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("t1")).toBe(10500);
  });

  it("negative adjustment: balance decreases", () => {
    const tx = mkTx({ id: "t1", kind: "adjustment", amountCents: -500, accountId: "acc1" });
    const result = computeRunningBalances([mkOpening(10000), tx], "acc1");
    expect(result.get("t1")).toBe(9500);
  });

  it("accumulates multiple transactions in ascending date order regardless of input order", () => {
    // Input is newest-first (as returned by listTransactions), but accumulation must be oldest-first.
    const t3 = mkTx({ id: "t3", kind: "expense", amountCents: 300, transactionDate: "2026-01-03", createdAt: "2026-01-03T00:00:00Z" });
    const t1 = mkTx({ id: "t1", kind: "income", amountCents: 1000, transactionDate: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" });
    const t2 = mkTx({ id: "t2", kind: "expense", amountCents: 200, transactionDate: "2026-01-02", createdAt: "2026-01-02T00:00:00Z" });
    const result = computeRunningBalances([t3, t1, t2], "acc1");
    // After t1: 0 + 1000 = 1000
    expect(result.get("t1")).toBe(1000);
    // After t2: 1000 - 200 = 800
    expect(result.get("t2")).toBe(800);
    // After t3: 800 - 300 = 500
    expect(result.get("t3")).toBe(500);
  });

  it("uses createdAt as stable tiebreaker when transactionDate is identical", () => {
    const open = mkOpening(500);
    const t1 = mkTx({ id: "t1", kind: "income", amountCents: 1000, transactionDate: "2026-01-01", createdAt: "2026-01-01T08:00:00Z" });
    const t2 = mkTx({ id: "t2", kind: "expense", amountCents: 400, transactionDate: "2026-01-01", createdAt: "2026-01-01T10:00:00Z" });
    const result = computeRunningBalances([t2, t1, open], "acc1");
    // t1 first (earlier createdAt): 500 + 1000 = 1500
    expect(result.get("t1")).toBe(1500);
    // t2 second: 1500 - 400 = 1100
    expect(result.get("t2")).toBe(1100);
  });
});

// ── opening kind ──────────────────────────────────────────────────────────────

describe("opening kind", () => {
  it("signedFor returns the opening amount as-is (already signed)", () => {
    expect(signedFor("opening", 5000)).toBe(5000);
    expect(signedFor("opening", -5000)).toBe(-5000);
  });

  it("computeRunningBalances starts at 0 with the opening row first", () => {
    const mk = (over: Partial<Transaction>): Transaction => ({
      id: "x", kind: "expense", accountId: "a", toAccountId: null, categoryId: "c",
      amountCents: 0, description: null, transactionDate: "2026-05-01", transactionTime: null,
      excludedFromReporting: false, createdAt: "1", updatedAt: "1", ...over,
    });
    const txns = [
      mk({ id: "open", kind: "opening", categoryId: null, amountCents: 10000, transactionDate: "2026-05-01", createdAt: "1" }),
      mk({ id: "inc", kind: "income", categoryId: "c", amountCents: 2500, transactionDate: "2026-05-02", createdAt: "2" }),
      mk({ id: "exp", kind: "expense", categoryId: "c", amountCents: 500, transactionDate: "2026-05-03", createdAt: "3" }),
    ];
    const map = computeRunningBalances(txns, "a");
    expect(map.get("open")).toBe(10000);
    expect(map.get("inc")).toBe(12500);
    expect(map.get("exp")).toBe(12000);
  });
});
