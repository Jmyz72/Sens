import { describe, it, expect } from "vitest";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { THEMES } from "../theme/tokens";

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
