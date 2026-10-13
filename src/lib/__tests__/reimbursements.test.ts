import { describe, expect, it } from "vitest";
import type { Category, Transaction } from "../../types";
import {
  apportion,
  candidateExpenses,
  defaultAllocationCents,
  effectiveCents,
  outstandingCents,
  reimbursementBadge,
  remainingCents,
} from "../reimbursements";

const exp = (over: Partial<Transaction> = {}): Transaction => ({
  id: "e", kind: "expense", accountId: "a", toAccountId: null, categoryId: "c1",
  amountCents: 10_000, description: null, transactionDate: "2026-06-01", transactionTime: null,
  excludedFromReporting: false, splits: [], expectedReimbursementCents: null, reimbursedCents: 0,
  allocations: [], createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", ...over,
});

const cat = (over: Partial<Category>): Category => ({
  id: "c1", name: "Food", kind: "expense", emoji: "🍜", color: null, parentId: null, sortOrder: 0,
  isArchived: false, isSystem: false, createdAt: "", updatedAt: "", ...over,
});

describe("apportion", () => {
  it("splits in proportion", () => {
    expect(apportion(5_000, [6_000, 4_000])).toEqual([3_000, 2_000]);
    expect(apportion(50, [100])).toEqual([50]);
    expect(apportion(100, [1, 99])).toEqual([1, 99]);
  });

  it("gives rounding cents to the largest remainders, ties to the earliest line", () => {
    expect(apportion(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(apportion(1, [2, 2])).toEqual([1, 0]);
    expect(apportion(7, [5, 3, 2])).toEqual([4, 2, 1]);
  });

  it("handles empty, zero, and overshoot", () => {
    expect(apportion(5, [])).toEqual([]);
    expect(apportion(0, [3, 4])).toEqual([0, 0]);
    expect(apportion(99, [2, 3])).toEqual([2, 3]);
    expect(apportion(-5, [2, 3])).toEqual([0, 0]);
  });

  it("always sums to the total and never exceeds a line", () => {
    for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) for (let c = 1; c <= 4; c++) {
      const w = [a, b, c];
      const sum = a + b + c;
      for (let total = 0; total <= sum; total++) {
        const s = apportion(total, w);
        expect(s.reduce((x, y) => x + y, 0)).toBe(total);
        s.forEach((share, i) => expect(share).toBeLessThanOrEqual(w[i]));
      }
    }
  });
});

describe("amounts", () => {
  it("effective is what is left after reimbursements", () => {
    expect(effectiveCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
  });

  it("outstanding is the expectation not yet received, never negative", () => {
    expect(outstandingCents(exp())).toBe(0);
    expect(outstandingCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 2_000 }))).toBe(5_000);
    expect(outstandingCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 9_000 }))).toBe(0);
  });

  it("remaining is what can still be allocated, adding back an editing reimbursement's own share", () => {
    expect(remainingCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
    expect(remainingCents(exp({ reimbursedCents: 10_000 }))).toBe(0);
    expect(remainingCents(exp({ reimbursedCents: 10_000 }), 10_000)).toBe(10_000);
  });
});

describe("defaultAllocationCents", () => {
  it("uses what is still expected, capped at what is left", () => {
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 7_000 }))).toBe(7_000);
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 3_000 }))).toBe(4_000);
  });

  it("falls back to everything left when nothing is expected or the claim is settled", () => {
    expect(defaultAllocationCents(exp())).toBe(10_000);
    expect(defaultAllocationCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 3_000, reimbursedCents: 5_000 }))).toBe(5_000);
  });

  it("counts an editing reimbursement's own share as still available", () => {
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 10_000, reimbursedCents: 10_000 }), 10_000)).toBe(10_000);
  });
});

describe("reimbursementBadge", () => {
  it("is pending while something is expected", () => {
    expect(reimbursementBadge(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 2_000 }))).toEqual({ state: "pending", cents: 5_000 });
  });

  it("is reimbursed once repaid", () => {
    expect(reimbursementBadge(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 7_000 }))).toEqual({ state: "reimbursed", cents: 7_000 });
    expect(reimbursementBadge(exp({ reimbursedCents: 500 }))).toEqual({ state: "reimbursed", cents: 500 });
  });

  it("is absent for an ordinary expense", () => {
    expect(reimbursementBadge(exp())).toBeNull();
  });
});

describe("candidateExpenses", () => {
  const sys = cat({ id: "sys", name: "Adjustment", isSystem: true });
  const cats = [cat({}), sys];

  it("keeps plain expenses with something left, expected ones first then newest first", () => {
    const list = [
      exp({ id: "old", transactionDate: "2026-05-01" }),
      exp({ id: "new", transactionDate: "2026-06-20" }),
      exp({ id: "exp", transactionDate: "2026-04-01", expectedReimbursementCents: 3_000 }),
      exp({ id: "done", reimbursedCents: 10_000 }),
      exp({ id: "fix", categoryId: "sys" }),
      exp({ id: "inc", kind: "income" }),
    ];
    expect(candidateExpenses(list, cats, []).map((t) => t.id)).toEqual(["exp", "new", "old"]);
  });

  it("keeps an expense an editing reimbursement already fully repays", () => {
    const list = [exp({ id: "done", reimbursedCents: 10_000 })];
    expect(candidateExpenses(list, cats, [{ expenseId: "done", amountCents: 10_000 }]).map((t) => t.id)).toEqual(["done"]);
  });
});
