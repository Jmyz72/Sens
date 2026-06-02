// src/__tests__/txnSelection.test.ts
import { describe, it, expect } from "vitest";
import { summarizeSelection, planBulk } from "../lib/txnSelection";
import type { Transaction, TransactionKind } from "../types";

function tx(kind: TransactionKind, amountCents: number, over: Partial<Transaction> = {}): Transaction {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    kind,
    accountId: "a1",
    toAccountId: kind === "transfer" ? "a2" : null,
    categoryId: kind === "income" || kind === "expense" ? "c1" : null,
    amountCents,
    description: null,
    transactionDate: "2026-06-01",
    transactionTime: null,
    excludedFromReporting: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

describe("summarizeSelection", () => {
  it("sums In/Out/net and counts other kinds", () => {
    const s = summarizeSelection([
      tx("income", 320000),
      tx("expense", 14280),
      tx("transfer", 50000),
      tx("adjustment", 800),
      tx("opening", 100000),
    ]);
    expect(s.count).toBe(5);
    expect(s.inCents).toBe(320000);
    expect(s.outCents).toBe(14280);
    expect(s.netCents).toBe(320000 - 14280);
    expect(s.otherCounts).toEqual({ transfer: 1, adjustment: 1, opening: 1 });
  });
  it("counts already-excluded income/expense", () => {
    const s = summarizeSelection([
      tx("expense", 100, { excludedFromReporting: true }),
      tx("expense", 200),
    ]);
    expect(s.excludedCount).toBe(1);
  });
});

describe("planBulk", () => {
  const sel = [
    tx("income", 320000, { id: "inc" }),
    tx("expense", 14280, { id: "exp" }),
    tx("transfer", 50000, { id: "trf" }),
    tx("adjustment", 800, { id: "adj" }),
    tx("opening", 100000, { id: "opn" }),
  ];

  it("recategorize: only income/expense change; others locked with reasons", () => {
    const p = planBulk("recategorize", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["exp", "inc"]);
    expect(p.lockedSkipped.map((l) => l.tx.id).sort()).toEqual(["adj", "opn", "trf"]);
    expect(p.lockedSkipped.find((l) => l.tx.id === "trf")!.reason).toMatch(/categor/i);
  });

  it("move: same eligibility as recategorize", () => {
    const p = planBulk("move", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["exp", "inc"]);
  });

  it("delete: everything except opening changes; opening locked", () => {
    const p = planBulk("delete", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["adj", "exp", "inc", "trf"]);
    expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["opn"]);
  });

  it("exclude: only not-yet-excluded income/expense change; others locked or omitted", () => {
    const withFlag = [
      tx("expense", 100, { id: "already", excludedFromReporting: true }),
      tx("expense", 200, { id: "fresh" }),
      tx("transfer", 50, { id: "trf" }),
    ];
    const p = planBulk("exclude", withFlag);
    expect(p.changeable.map((t) => t.id)).toEqual(["fresh"]);
    expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["trf"]);
  });

  it("include: only currently-excluded income/expense change", () => {
    const withFlag = [
      tx("expense", 100, { id: "already", excludedFromReporting: true }),
      tx("expense", 200, { id: "fresh" }),
    ];
    const p = planBulk("include", withFlag);
    expect(p.changeable.map((t) => t.id)).toEqual(["already"]);
    expect(p.lockedSkipped).toEqual([]);
  });

  it("recategorize with no target: all income/expense are changeable (panel count)", () => {
    const p = planBulk("recategorize", [tx("income", 100, { id: "i" }), tx("expense", 200, { id: "e" })]);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["e", "i"]);
  });

  it("recategorize with only an expense target: expense changes, income skipped with reason", () => {
    const p = planBulk("recategorize", [tx("income", 100, { id: "i" }), tx("expense", 200, { id: "e" })], { expenseCategory: { id: "c1", name: "Food" } });
    expect(p.changeable.map((t) => t.id)).toEqual(["e"]);
    expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["i"]);
    expect(p.lockedSkipped[0].reason).toMatch(/income/i);
  });

  it("recategorize with both targets: all change", () => {
    const p = planBulk("recategorize", [tx("income", 100, { id: "i" }), tx("expense", 200, { id: "e" })], { incomeCategory: { id: "c2", name: "Salary" }, expenseCategory: { id: "c1", name: "Food" } });
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["e", "i"]);
    expect(p.lockedSkipped).toEqual([]);
  });
});
